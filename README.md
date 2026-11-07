# Care AI Vision

AI-powered [CARE](https://github.com/ohcnetwork/care_fe) App (plugin) to extract and auto-fill patient registration details from scanned or photographed forms.

## Features

- 📷 **Scan or upload** — pick an image from camera, gallery, or file picker
- 🤖 **AI-powered extraction** — uses Care AI backend to extract structured patient data from form images
- 🏛️ **Governance resolution** — automatically resolves State → District → Local Body → Ward hierarchy via Care's Organization API
- ✅ **Auto-fills form fields** — name, phone, gender, DOB/age, blood group, address, pincode, and governance location
- 🔁 **Retry on failure** — reprocesses the same image without re-upload


## Getting Started

### Prerequisites

- A running [Care frontend](https://github.com/ohcnetwork/care_fe) instance to host this plugin
- A running [Care backend](https://github.com/ohcnetwork/care) with the [care_filly plugin](https://github.com/ohcnetwork/care_filly) installed — it mints the session-scoped Medispeak tokens so the browser never holds the Medispeak account secret
- A Medispeak account, with `MEDISPEAK_API_KEY` configured on care_filly

### Installation

```bash
git clone https://github.com/ohcnetwork/care_ai_vision.git
cd care_ai_vision
npm install
```

### Configuration

Set the Medispeak API root, either:

- `MEDISPEAK_API_URL` in this plugin's config in CARE (Admin → plugins) — no rebuild needed, or
- `REACT_MEDISPEAK_API_URL` in `.env` for local development (requires a rebuild)

Lab values below `LOW_CONFIDENCE_THRESHOLD` (plugin config) or `REACT_LOW_CONFIDENCE_THRESHOLD` (`.env`) are marked **Check this**. Default is `0.99`. Use `0.99` or `99`.

> care_filly holds the `MEDISPEAK_API_KEY` account secret and mints short-lived, session-scoped tokens. This plugin only ever talks to Medispeak with those scoped tokens.

### Development

```bash
npm start
```

This starts the dev server on port **10120** with hot reload.

### Production Build

```bash
npm run build
```

## How It Works

1. User clicks "Scan Registration Form" on the patient registration page
2. Browser shows native image picker (camera / gallery / files)
3. care_filly creates a document-modality Medispeak session and mints a scoped token
4. The image is uploaded straight to Medispeak using that token and committed for OCR + structured extraction (a typed "form" output, not a freeform prompt)
5. The plugin polls the session until it reaches a terminal status, then reads back the structured fields
6. Extracted fields are validated and auto-filled into the form
7. Governance hierarchy (state/district/local body/ward) is resolved via Care's Organization API
8. User reviews extracted data and confirms

