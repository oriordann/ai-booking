// businesses.js
module.exports = {
  gp: {
    id: "gp",
    name: "Lower Friars Walk Clinic",
    industry: "healthcare",
    brand: { primary: "#0d6efd", accent: "#198754" },
    copy: {
      greeting: "Hi — I can help you book an appointment. What’s the issue?",
      pickDate: "Choose a date:",
      pickTime: (date) => `Times available on ${date}:`,
      confirm: (date, time) => `Appointment confirmed for ${date} at ${time} ✅`,
      fallback: "I can help you book a GP appointment. Say something like “I need to see a doctor”."
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
      greeting: "Hi! I can book you in. What would you like to do?",
      pickDate: "Choose a date for your session:",
      pickTime: (date) => `Available times on ${date}:`,
      confirm: (date, time) => `Booked ✅ ${date} at ${time}. See you then!`,
      fallback: "Say something like “Book a PT session tomorrow”."
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
      greeting: "Hi — I can book a viewing or valuation. What do you need?",
      pickDate: "Choose a date:",
      pickTime: (date) => `Viewing times on ${date}:`,
      confirm: (date, time) => `Booked ✅ ${date} at ${time}. We’ll be in touch.`,
      fallback: "Say “Book a viewing tomorrow”."
    },
    intake: [
      { field: "client_name", label: "Your name", required: true },
      { field: "client_phone", label: "Phone number", required: true },
      { field: "property", label: "Property / area", required: true }
    ]
  }
};
