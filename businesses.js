// businesses.js
module.exports = {
  gp: {
    id: "gp",
    name: "Lower Friars Walk Centre",
    industry: "healthcare",
    brand: { primary: "#0d6efd", accent: "#198754" },
    copy: {
      greeting: "Hi — I can help you book an appointment. What’s the issue?",
      intro:
      "Welcome to Lower Friars Walk Medical Centre.\n\n" +
      "To book an appointment, please type:\n" +
      "“I need to see a doctor”",
      pickDate: "When would you like to come in? Choose a date:",
      pickTime: (date) => `Times available on ${date}:`,
      confirm: (date, time) => `Appointment confirmed for ${date} at ${time} ✅`,
      fallback: "I can help you book a GP appointment. Say something like “I need to see a doctor”.",
      pickDateNoTimes: "No times left for that date — please choose another date:",
      invalidDate: "That date isn’t available — please pick one of the date buttons (or type today/tomorrow).",
      invalidTime: "That time isn’t available—please pick one of the time buttons.",
      askName: "Great — what name should I put on the appointment?",
      askReason: "Thanks. Briefly, what’s the reason for the visit? (e.g. cough, earache, medication review)",
      askPhone: "Optional: what phone number should we use? (Or type 'skip')",
      alreadyConfirmed: "Your appointment is already confirmed. Type reset to start again.",
      unknownNext: "I’m not sure what to do next—type reset to start again."
    },
    intake: [
      { field: "patient_name", label: "Your name", required: true },
      { field: "patient_phone", label: "Phone number", required: true },
      { field: "reason", label: "Brief reason", required: true }
    ]
  },

  fitness: {
    id: "fitness",
    name: "Orla Fitness Cork",
    industry: "fitness",
    brand: { primary: "#111827", accent: "#f59e0b" },
    copy: {
      greeting: "Hi! I'm Orla's virtual assistant. Can I book you in for a fitness session?",
      pickDate: "Choose a date for your session:",
      pickTime: (date) => `Available times on ${date}:`,
      confirm: (date, time) => `Session confirmed ✅ ${date} at ${time}. See you then!`,
      fallback: "Say something like “Book a PT session tomorrow”.",
      pickDateNoTimes: "No times left for that date — please choose another date:",
      invalidDate: "That date isn’t available — please pick one of the date buttons (or type today/tomorrow).",
      invalidTime: "That time isn’t available—please pick one of the time buttons.",
      askName: "Great — what name should I put on the session?",
      askReason: "Thanks. What type of session would u like? (e.g. core, upper body, legs, stretch, meditation)",
      askPhone: "Optional: what phone number should we use? (Or type 'skip')",
      alreadyConfirmed: "Your session is already confirmed. Type reset to start again.",
      unknownNext: "I’m not sure what to do next—type reset to start again."
    },
    intake: [
      { field: "client_name", label: "Your name", required: true },
      { field: "client_phone", label: "Phone number", required: true },
      { field: "notes", label: "Goal / notes (optional)", required: false }
    ]
  },

  estate: {
    id: "estate",
    name: "REA O'Donoghue Clarke",
    industry: "real_estate",
    brand: { primary: "#7c3aed", accent: "#0ea5e9" },
    copy: {
      greeting: "Hi — I'm Steve's virtual assistant. I can book you in for a viewing or valuation. What do you need?",
      pickDate: "Choose a date:",
      pickTime: (date) => `Viewing times on ${date}:`,
      confirm: (date, time) => `Appointment Confirmed ✅ ${date} at ${time}. See you then!`,
      fallback: "Say “Book an appointment”.",
      pickDateNoTimes: "No times left for that date — please choose another date:",
      invalidDate: "That date isn’t available — please pick one of the date buttons (or type today/tomorrow).",
      invalidTime: "That time isn’t available—please pick one of the time buttons.",
      askName: "Great — what name should I put on the appointment?",
      askReason: "Thanks. What type of appointment would u like? (e.g. valuation, viewing, selling/buying a property)",
      askPhone: "Optional: what phone number should we use? (Or type 'skip')",
      alreadyConfirmed: "Your appointment is already confirmed. Type reset to start again.",
      unknownNext: "I’m not sure what to do next—type reset to start again."
    },
    intake: [
      { field: "client_name", label: "Your name", required: true },
      { field: "client_phone", label: "Phone number", required: true },
      { field: "property", label: "Property / area", required: true }
    ]
  }
};
