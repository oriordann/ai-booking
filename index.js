const express = require('express');
const path = require('path');
const OpenAI = require("openai");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname))); // serves index.html

// OpenAI client
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

//Basic Auth for admin
const basicAuth = require('express-basic-auth');
const ADMIN_USER = process.env.ADMIN_USER || "gp";
const ADMIN_PASS = process.env.ADMIN_PASS || "change-me";

// Database
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./appointments.db');

// Render
const PORT = process.env.PORT || 3000;

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      date TEXT,
      time TEXT,
      status TEXT DEFAULT 'confirmed',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`ALTER TABLE appointments ADD COLUMN patient_name TEXT`, () => {});
  db.run(`ALTER TABLE appointments ADD COLUMN patient_phone TEXT`, () => {});
  db.run(`ALTER TABLE appointments ADD COLUMN reason TEXT`, () => {});


  // Drop older indexes if they exist
  db.run(`DROP INDEX IF EXISTS idx_appt_unique`);
  db.run(`DROP INDEX IF EXISTS idx_appt_unique_status`);

  // Enforce uniqueness ONLY for confirmed bookings
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_unique_confirmed
    ON appointments(date, time)
    WHERE status = 'confirmed'
  `);
});


// Check Database for times already confirmed
function getBookedTimesForDate(date) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT time FROM appointments WHERE date = ? AND status = 'confirmed'`,
      [date],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(r => r.time));
      }
    );
  });
}

// Check for use of today and tomorrow
function dublinISODate(offsetDays = 0) {
  // Get "today" in Europe/Dublin as YYYY-MM-DD
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const y = Number(parts.find(p => p.type === 'year').value);
  const m = Number(parts.find(p => p.type === 'month').value);
  const d = Number(parts.find(p => p.type === 'day').value);

  // Create a date at noon UTC to avoid DST edge cases, then add offset
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + offsetDays);

  return base.toISOString().slice(0, 10);
}

function normaliseDateInput(message) {
  const m = (message || "").trim().toLowerCase();

  if (m.includes("tomorrow")) return dublinISODate(1);
  if (m.includes("today")) return dublinISODate(0);

  return (message || "").trim();
}




// Local fallback (so app still works if OpenAI fails or cap hit)
function detectIntentLocal(message) {
  const m = (message || "").toLowerCase();
  const bookWords = [
    "book", "booking", "appointment", "gp", "doctor",
    "see a doctor", "see gp", "schedule", "visit", "consultation"
  ];
  if (bookWords.some(w => m.includes(w))) return "BOOK";
  return "OTHER";
}

async function detectIntent(message) {
  const resp = await client.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: `
You are an intent classifier for a GP booking system.

Return BOOK if the user wants to:
- see a doctor
- book or request an appointment
- talk to a GP
- get medical help in person

Return OTHER only if they are NOT asking to see a doctor.

Reply with exactly one word: BOOK or OTHER.
`
      },
      { role: "user", content: message }
    ],
  });

  return resp.output_text.trim().toUpperCase();
}

// Mock GP appointment slots
const slots = {
  '2025-12-20': ['10:00', '11:00', '14:00'],
  '2025-12-21': ['09:30', '13:00', '15:00'],
  '2025-12-28': ['09:30', '13:00', '15:00']
};

// Temporary in-memory conversation state
const conversations = {};

// Health check
app.get('/', (req, res) => {
  res.send('AI Booking backend is running 🚀');
});

const businesses = require("./businesses");

function getBiz(req) {
  const biz = (req.query.biz || req.headers["x-biz"] || "gp").toString();
  return businesses[biz] ? biz : "gp";
}

app.get("/config", (req, res) => {
  const biz = getBiz(req);
  const cfg = businesses[biz];

  res.json({
    biz: cfg.id,
    name: cfg.name,
    brand: cfg.brand,
    greeting: cfg.copy.greeting
  });
});

app.post('/chat', async (req, res) => {
const { userId, message, biz = "gp" } = req.body;
const cfg = businesses[biz] || businesses.gp;

console.log("chat req: ", {userId, message, biz});

  if (!userId || !message) {
    return res.status(400).json({ error: 'userId and message are required' });
  }

  // Reset conversation
  if (message.toLowerCase() === 'reset') {
    conversations[userId] = {
      step: 'start',
      selectedDate: null,
      selectedTime: null,
      patientName: null,
      patientPhone: null,
      reason: null
    };

    return res.json({ reply: 'Conversation reset. How can I help you?' });
  }

  // Initialize memory
  if (!conversations[userId]) {
    conversations[userId] = { step: 'start', selectedDate: null };
  }

  const convo = conversations[userId];
  let reply;

  // --- Conversation logic ---
  if (convo.step === 'start') {
    let intent = "OTHER";
    try {
      intent = await detectIntent(message);
    } catch (e) {
      console.error("OpenAI error (fallback to local)");
      console.error("Status:", e?.status);
      console.error("Message:", e?.message);
      console.error("Details:", e?.error || e?.response?.data || e);
      intent = detectIntentLocal(message);
    }

if (intent === "BOOK") {
  const dateInput = normaliseDateInput(message);

  // If user already provided a valid date (today/tomorrow/YYYY-MM-DD), skip date selection
  if (slots[dateInput]) {
    convo.selectedDate = dateInput;

    try {
      const bookedTimes = await getBookedTimesForDate(dateInput);
      const availableTimes = slots[dateInput].filter(t => !bookedTimes.includes(t));

      if (availableTimes.length === 0) {
        // No times left on that date -> show all date options instead
        reply = {
          text: cfg.copy.pickDateNoTimes,
          options: Object.keys(slots)
        };
        convo.step = 'date_selected';
      } else {
        reply = {
          text: cfg.copy.pickTime(dateInput),
          options: availableTimes
        };
        convo.step = 'time_selected';
      }
    } catch (err) {
      console.error("DB error reading booked times:", err);
      reply = {
        text: "Please choose a date",
        options: Object.keys(slots)
      };
      convo.step = 'date_selected';
    }
  } else {
    // No date given -> show date buttons
    reply = {
      text: cfg.copy.pickDate,
      options: Object.keys(slots)
    };
    convo.step = 'date_selected';
  }
} else {
    reply = cfg.copy.fallback;
}
  }
else if (convo.step === 'date_selected') {
  const dateInput = normaliseDateInput(message);

  if (!slots[dateInput]) {
      reply = cfg.copy.invalidDate;
  } else {
    convo.selectedDate = dateInput;

    try {
      const bookedTimes = await getBookedTimesForDate(dateInput);
      const availableTimes = slots[dateInput].filter(t => !bookedTimes.includes(t));

      if (availableTimes.length === 0) {
        reply = cfg.copy.pickDateNoTimes;
        // stay in date_selected
      } else {
        reply = {
          text: cfg.copy.pickTime(dateInput),
          options: availableTimes
        };
        convo.step = 'time_selected';
      }
    } catch (err) {
      console.error("DB error reading booked times:", err);
      reply = "Sorry — I couldn't load availability. Please try again.";
    }
  }
}


else if (convo.step === 'time_selected') {
  if (convo.selectedDate && slots[convo.selectedDate].includes(message)) {
    convo.selectedTime = message;
    convo.step = 'collect_name';
    reply = cfg.copy.askName;
  } else {
      reply = cfg.copy.invalidTime;
  }
}

else if (convo.step === 'collect_name') {
  convo.patientName = message.trim();
  convo.step = 'collect_reason';
  reply = cfg.copy.askReason;
}
else if (convo.step === 'collect_reason') {
  convo.reason = message.trim();
  convo.step = 'collect_phone';
  reply = cfg.copy.askPhone;
}
else if (convo.step === 'collect_phone') {
  const m = message.trim();
  convo.patientPhone = (m.toLowerCase() === 'skip') ? null : m;

  // Now save to DB
  db.run(
    `INSERT INTO appointments (user_id, date, time, status, patient_name, patient_phone, reason)
     VALUES (?, ?, ?, 'confirmed', ?, ?, ?)`,
    [userId, convo.selectedDate, convo.selectedTime, convo.patientName, convo.patientPhone, convo.reason],
    function (err) {
      if (err) {
        // Unique constraint = someone else booked it
        if (err.message && err.message.includes('UNIQUE')) {
          convo.step = 'time_selected';
          return res.json({ reply: "Sorry — that slot was just booked. Please pick another time." });
        }
        console.error("Insert DB error:", err.message);
        return res.status(500).json({ reply: "Something went wrong saving your booking. Please try again." });
      }

      convo.step = 'confirmed';
      return res.json({
        reply: cfg.copy.confirm(convo.patientName, convo.selectedDate, convo.selectedTime)
      });
    }
  );
  return; // IMPORTANT: stop here because we already responded in the callback
}

  else if (convo.step === 'confirmed') {
    reply = cfg.copy.alreadyConfirmed;
  } else {
    reply = cfg.copy.unknownNext;
  }

  res.json({ reply });
});

// Basic admin authentication
app.use('/admin', basicAuth({
  users: { [ADMIN_USER]: ADMIN_PASS },
  challenge: true,
}));


// Admin console
app.get('/admin', (req, res) => {
  db.all(
    `SELECT id, user_id, date, time, status, created_at, patient_name, patient_phone, reason
   FROM appointments
   ORDER BY
     CASE status WHEN 'confirmed' THEN 0 ELSE 1 END,
     date, time`,
    [],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).send("DB error");
      }

const html = `
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">

  <style>
    body { font-family: Arial, sans-serif; margin: 0; background:#f6f7f9; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 12px; }
    h2 { margin: 10px 0 6px; font-size: 18px; }
    .hint { color:#666; font-size: 13px; margin-bottom: 10px; }

    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow:hidden; }
    th, td { padding: 10px; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; }
    th { background:#fafafa; font-size: 13px; color:#333; }
    tr:last-child td { border-bottom: none; }

    .row-confirmed { background:#e6ffed; }
    .row-cancelled { background:#ffe6e6; color:#555; }

    button { padding: 8px 12px; border-radius: 8px; border: none; cursor: pointer; color:#fff; }
    .btn-cancel { background:#dc3545; }
    .btn-reinstate { background:#198754; }

    /* Mobile: turn table into cards */
    @media (max-width: 720px) {
      table, thead, tbody, th, td, tr { display: block; }
      thead { display: none; }
      table { background: transparent; border-radius: 0; overflow: visible; }
      tr {
        background: #fff;
        margin-bottom: 10px;
        border-radius: 12px;
        overflow: hidden;
        border: 1px solid #e9e9e9;
      }
      td {
        border: none;
        border-bottom: 1px solid #f0f0f0;
        display: flex;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        word-break: break-word;
      }
      td:last-child { border-bottom: none; }
      td::before {
        content: attr(data-label);
        font-weight: 600;
        color: #444;
        flex: 0 0 110px;
      }
      .actions { justify-content: flex-end; }
    }
      
    @media (max-width: 720px) {
      td.actions::before {
        content: "";
        flex: 0;
      }
    }

    td.actions {
      justify-content: flex-end;
    }

    @media (max-width: 720px) {
      td.actions form,
      td.actions button {
        width: 100%;
    }
    



  </style>

  <div class="wrap">
    <h2>Appointments</h2>
    <div class="hint">Confirmed at the top, cancelled below.</div>

    <table>
      <thead>
        <tr>
          <th>Date</th><th>Time</th>
          <th>Status</th><th>Created</th><th>Name</th><th>Phone</th><th>Reason</th><th>Actions</th>
        </tr>
      </thead>

      <tbody>
        ${rows.map(r => {
          const rowClass = r.status === 'confirmed' ? 'row-confirmed' : 'row-cancelled';

          return `
            <tr class="${rowClass}">
              <td data-label="Date">${r.date}</td>
              <td data-label="Time">${r.time}</td>
              <td data-label="Status">${r.status}</td>
              <td data-label="Created">${r.created_at}</td>
              <td data-label="Name">${r.patient_name || ''}</td>
              <td data-label="Phone">${r.patient_phone || ''}</td>
              <td data-label="Reason">${r.reason || ''}</td>
              <td data-label="Actions" class="actions">
                ${
                  r.status === 'confirmed'
                    ? `<form method="POST" action="/admin/appointments/${r.id}/cancel" style="display:inline;">
                        <button class="btn-cancel" type="submit">Cancel</button>
                      </form>`
                    : `<form method="POST" action="/admin/appointments/${r.id}/reinstate" style="display:inline;">
                        <button class="btn-reinstate" type="submit">Reinstate</button>
                      </form>`
                }
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  </div>
`;


      res.send(html);
    }
  );
});


// Admin cancel functionality
app.post('/admin/appointments/:id/cancel', (req, res) => {
  const { id } = req.params;

  db.run(
    `UPDATE appointments SET status = 'cancelled' WHERE id = ?`,
    [id],
    function (err) {
      if (err) {
        console.error("Cancel DB error:", err.message);
        return res.status(500).send("DB error: " + err.message);
      }
      return res.redirect('/admin');
    }
  );
});

// Admin reinstate functionality
app.post('/admin/appointments/:id/reinstate', (req, res) => {
  const { id } = req.params;

  db.run(
    `UPDATE appointments SET status = 'confirmed' WHERE id = ?`,
    [id],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).send("DB error");
      }
      return res.redirect('/admin');
    }
  );
});


app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
