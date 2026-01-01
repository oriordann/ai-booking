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

// Twilio - Whatsapp chat
const twilio = require("twilio");

app.use(express.urlencoded({ extended: false }));

app.post("/whatsapp/inbound", async (req, res) => {
  try {
    const from = req.body.From;                 // "whatsapp:+353..."
    let body = (req.body.Body || "").trim();    // user message (let because we may rewrite it)
    const biz = req.query.biz || "gp";

    // ✅ If user replies with a number (1/2/3), map it to the last options we sent them
    const n = parseInt(body, 10);
    if (!Number.isNaN(n) && conversations[from]?.lastOptions?.length) {
      const opts = conversations[from].lastOptions;
      if (n >= 1 && n <= opts.length) {
        body = opts[n - 1];              // turn "2" into "2025-12-21" (or "10:00")
        conversations[from].lastOptions = null; // clear after use
      }
    }

    const reply = await handleChatMessage({
      userId: from,
      biz,
      message: body
    });

    const twiml = new twilio.twiml.MessagingResponse();

    if (typeof reply === "string") {
      twiml.message(reply);

    } else if (reply && typeof reply === "object") {
      const options = reply.options || [];

      // ✅ store options so the next inbound "1/2/3" can be mapped
      if (!conversations[from]) conversations[from] = { step: "start" };
      conversations[from].lastOptions = options;

      const numbered = options.map((o, i) => `${i + 1}) ${o}`).join("\n");
      twiml.message(`${reply.text}\n${numbered}\n\nReply with a number (1-${options.length}).`);

    } else {
      twiml.message("Sorry — I couldn’t process that. Please try again.");
    }

    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("WhatsApp inbound error:", err);
    res.status(500).send("Error");
  }
});



db.serialize(() => {
db.run(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    biz_id TEXT,
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
  db.run(`ALTER TABLE appointments ADD COLUMN biz_id TEXT`, () => {});


  // Drop older indexes if they exist
  db.run(`DROP INDEX IF EXISTS idx_appt_unique`);
  db.run(`DROP INDEX IF EXISTS idx_appt_unique_status`);

  // Enforce uniqueness ONLY for confirmed bookings
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_unique_confirmed
    ON appointments(biz_id, date, time)
    WHERE status = 'confirmed'
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS availability (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      biz_id TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      capacity INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_avail_unique
    ON availability(biz_id, date, time)
  `);


});


// Check Database for times already confirmed
function getBookedTimesForDate(bizId, date) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT time FROM appointments
       WHERE biz_id = ? AND date = ? AND status = 'confirmed'`,
      [bizId, date],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(r => r.time));
      }
    );
  });
}

function getAvailableDates(bizId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT DISTINCT date
       FROM availability
       WHERE biz_id = ?
       ORDER BY date`,
      [bizId],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(r => r.date));
      }
    );
  });
}

function getAvailableTimesForDate(bizId, date) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT time FROM availability
       WHERE biz_id = ? AND date = ?
       ORDER BY time`,
      [bizId, date],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(r => r.time));
      }
    );
  });
}

async function getFreeTimesForDate(bizId, date) {
  const [availTimes, bookedTimes] = await Promise.all([
    getAvailableTimesForDate(bizId, date),
    getBookedTimesForDate(bizId, date),
  ]);

  return availTimes.filter(t => !bookedTimes.includes(t));
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

// For Twilio and Whatsapp integration
async function handleChatMessage({ userId, message, biz = "gp" }) {
  // safety defaults
  biz = (biz || "gp").toString();
  const cfg = businesses[biz] || businesses.gp;

  console.log("chat req:", { userId, message, biz });

  if (!userId || !message) {
    return "userId and message are required";
  }

  // Reset conversation
  if (message.toLowerCase() === "reset") {
    conversations[userId] = {
      step: "start",
      selectedDate: null,
      selectedTime: null,
      patientName: null,
      patientPhone: null,
      reason: null
    };
    return "Conversation reset. How can I help you?";
  }

  // Initialize memory
  if (!conversations[userId]) {
    conversations[userId] = {
      step: "start",
      selectedDate: null,
      introShown: true
    };

    // 👇 send intro immediately
    return cfg.copy.intro;
  }

  const dates = await getAvailableDates(biz);
  const convo = conversations[userId];
  let reply;

  // --- Conversation logic ---
if (convo.step === "start") {
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

    // ✅ Get available dates from DB (per business)
    const dates = await getAvailableDates(biz);

    // If user already provided a valid date (today/tomorrow/YYYY-MM-DD), skip date selection
    if (dates.includes(dateInput)) {
      convo.selectedDate = dateInput;

      try {
        const freeTimes = await getFreeTimesForDate(biz, dateInput);

        if (freeTimes.length === 0) {
          reply = {
            text: "No times left for that date — please choose another date:",
            options: dates
          };
          convo.step = "date_selected";
        } else {
          reply = {
            text: `Times available on ${dateInput}:`,
            options: freeTimes
          };
          convo.step = "time_selected";
        }
      } catch (err) {
        console.error("DB error reading free times:", err);
        reply = { text: cfg.copy.askDate || "Please choose a date:", options: dates };
        convo.step = "date_selected";
      }

    } else {
      // No valid date supplied -> show date buttons
      reply = {
        text: "When would you like to come in? Choose a date:",
        options: dates
      };
      convo.step = "date_selected";
    }

  } else {
    reply = cfg.copy?.fallback
      || "I can help you book an appointment. Just say something like “I need to book an appointment”.";
  }
}


else if (convo.step === "date_selected") {
  const dateInput = normaliseDateInput(message);

  // ✅ Validate the date against DB availability (not the old slots object)
  const dates = await getAvailableDates(biz);
  if (!dates.includes(dateInput)) {
    reply = "That date isn’t available — please pick one of the date options (or type today/tomorrow).";
    return reply; // <-- remove this line if you're inside handleChatMessage, see note below
  }

  convo.selectedDate = dateInput;

  try {
    const freeTimes = await getFreeTimesForDate(biz, dateInput);

    if (freeTimes.length === 0) {
      reply = "Sorry — no times left on that date. Please pick another date.";
      // stay in date_selected
    } else {
      reply = { text: `Times available on ${dateInput}:`, options: freeTimes };
      convo.step = "time_selected";
    }
  } catch (err) {
    console.error("DB error reading free times:", err);
    reply = "Sorry — I couldn't load availability. Please try again.";
  }
}


else if (convo.step === "time_selected") {
  if (!convo.selectedDate) {
    convo.step = "date_selected";
    reply = "Please choose a date first.";
  } else {
    try {
      const freeTimes = await getFreeTimesForDate(biz, convo.selectedDate);

      if (freeTimes.includes(message)) {
        convo.selectedTime = message;
        convo.step = "collect_name";
        reply = "Great — what name should I put on the appointment?";
      } else {
        reply = "That time isn’t available—please pick one of the time options.";
      }
    } catch (err) {
      console.error("DB error reading free times:", err);
      reply = "Sorry — I couldn't confirm availability. Please try again.";
    }
  }
}


  else if (convo.step === "collect_name") {
    convo.patientName = message.trim();
    convo.step = "collect_reason";
    reply = "Thanks. Briefly, what’s the reason for the visit? (e.g. cough, earache, medication review)";
  }

  else if (convo.step === "collect_reason") {
    convo.reason = message.trim();
    convo.step = "collect_phone";
    reply = "Optional: what phone number should we use? (Or type 'skip')";
  }

  else if (convo.step === "collect_phone") {
    const m = message.trim();
    convo.patientPhone = (m.toLowerCase() === "skip") ? null : m;

    // Wrap db.run in a Promise so we can return a final message
    const result = await new Promise((resolve) => {
      db.run(
        `INSERT INTO appointments (biz_id, user_id, date, time, status, patient_name, patient_phone, reason)
         VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
        [biz, userId, convo.selectedDate, convo.selectedTime, convo.patientName, convo.patientPhone, convo.reason],
        function (err) {
          if (err) {
            if (err.message && err.message.includes("UNIQUE")) {
              convo.step = "time_selected";
              return resolve("Sorry — that slot was just booked. Please pick another time.");
            }
            console.error("Insert DB error:", err.message);
            return resolve("Something went wrong saving your booking. Please try again.");
          }

          convo.step = "confirmed";
          return resolve(
            `Appointment confirmed for ${convo.patientName} on ${convo.selectedDate} at ${convo.selectedTime} ✅`
          );
        }
      );
    });

    return result; // IMPORTANT: we already have the final reply
  }

  else if (convo.step === "confirmed") {
    reply = "Your appointment is already confirmed. Type reset to start again.";
  }

  else {
    reply = "I’m not sure what to do next—type reset to start again.";
  }

  return reply;
}







app.post("/chat", async (req, res) => {
  const { userId, message, biz = "gp" } = req.body;

  const reply = await handleChatMessage({ userId, message, biz });

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

// Availability DB
app.get("/admin/availability", (req, res) => {
  const biz = (req.query.biz || "gp").toString();

  db.all(
    `SELECT id, biz_id, date, time, capacity
     FROM availability
     WHERE biz_id = ?
     ORDER BY date, time`,
    [biz],
    (err, rows) => {
      if (err) return res.status(500).send("DB error");

      const html = `
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial; margin:0; background:#f6f7f9; }
          .wrap { max-width: 900px; margin: 0 auto; padding: 12px; }
          table { width:100%; border-collapse: collapse; background:#fff; border-radius:10px; overflow:hidden; }
          th, td { padding:10px; border-bottom:1px solid #eee; text-align:left; }
          th { background:#fafafa; font-size: 13px; }
          .row { display:flex; gap:8px; flex-wrap:wrap; margin: 10px 0; }
          input { padding:10px; border-radius:8px; border:1px solid #ddd; }
          button { padding:10px 12px; border-radius:8px; border:none; cursor:pointer; color:#fff; background:#007bff; }
          .delBtn { background:#dc3545; }
        </style>

        <div class="wrap">
          <h2>Availability (${biz})</h2>
          <div><a href="/admin?biz=${biz}">← Appointments</a></div>

          <form class="row" method="POST" action="/admin/availability/add?biz=${biz}">
            <input name="date" placeholder="YYYY-MM-DD" required />
            <input name="time" placeholder="HH:MM" required />
            <input name="capacity" type="number" min="1" value="1" />
            <button type="submit">Add slot</button>
          </form>

          <table>
            <thead><tr><th>Date</th><th>Time</th><th>Capacity</th><th>Actions</th></tr></thead>
            <tbody>
              ${rows.map(r => `
                <tr>
                  <td>${r.date}</td>
                  <td>${r.time}</td>
                  <td>${r.capacity || 1}</td>
                  <td>
                    <form method="POST" action="/admin/availability/${r.id}/delete?biz=${biz}" style="display:inline;">
                      <button class="delBtn" type="submit">Delete</button>
                    </form>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `;
      res.send(html);
    }
  );
});

app.post("/admin/availability/add", (req, res) => {
  const biz = (req.query.biz || "gp").toString();
  const { date, time, capacity } = req.body;

  db.run(
    `INSERT OR IGNORE INTO availability (biz_id, date, time, capacity)
     VALUES (?, ?, ?, ?)`,
    [biz, date, time, Number(capacity || 1)],
    (err) => {
      if (err) return res.status(500).send("DB error");
      res.redirect(`/admin/availability?biz=${biz}`);
    }
  );
});

app.post("/admin/availability/:id/delete", (req, res) => {
  const biz = (req.query.biz || "gp").toString();
  const { id } = req.params;

  db.run(`DELETE FROM availability WHERE id = ?`, [id], (err) => {
    if (err) return res.status(500).send("DB error");
    res.redirect(`/admin/availability?biz=${biz}`);
  });
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
