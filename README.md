# Fireflies.ai Attendance Tracker

A **Cloudflare Worker** that automatically tracks meeting attendance using Fireflies.ai webhooks and Google Sheets integration.

## Features

- 🎯 **Smart Attendance Detection**: Uses speaker analytics (talk time, word count, questions) to determine who actively participated
- 📊 **Google Sheets Integration**: Automatically appends attendance data to your spreadsheet
- ⚙️ **Configurable Thresholds**: Adjust activity requirements without redeploying
- 🔄 **Webhook Processing**: Handles Fireflies.ai transcription complete webhooks
- 📈 **Confidence Scoring**: Provides confidence levels and reasoning for attendance decisions

## How It Works

1. **Fireflies.ai** sends a webhook when transcription is complete
2. **Worker** fetches meeting data and speaker analytics via GraphQL
3. **Attendance Logic** determines who was "active" based on configurable thresholds
4. **Google Sheets** receives new rows with attendance data

## Quick Start

### 1. Prerequisites

- **Fireflies.ai API key** (Bearer token)
- **Google Service Account** with Sheets access
- **Google Sheet** with proper headers (see below)

### 2. Setup

```bash
# Install dependencies
npm install

# Configure your sheet ID in wrangler.toml
# Update SHEET_ID = "your-actual-sheet-id"

# Set secrets
npm run secret:fireflies    # Your Fireflies API key
npm run secret:google-email # Service account email
npm run secret:google-key   # Service account private key

# Deploy
npm run deploy
```

### 3. Google Sheet Setup

Create a sheet with these headers in row 1:

```
Timestamp, MeetingID, Person, Attended, Confidence, Reason, Title, Date, DurationSec, FirefliesTranscriptURL
```

Share the sheet with your Google Service Account email.

### 4. Fireflies.ai Setup

1. **Get API Key**: Fireflies Dashboard → API
2. **Create Webhook**: Point to your deployed Worker URL
   - Event: "Transcription complete"
   - Or use "Super Admin Webhook" for org-wide coverage

## Configuration

### Environment Variables

Edit `wrangler.toml` to customize:

```toml
[vars]
SHEET_ID = "your-sheet-id"
SHEET_TAB = "Attendance"           # Tab name in your sheet
ACTIVE_WORDS_MIN = "30"            # Minimum words spoken
ACTIVE_DURATION_MIN_SEC = "90"     # Minimum speaking time (seconds)
ACTIVE_QUESTIONS_MIN = "1"         # Minimum questions asked
```

### Attendance Logic

A person is marked as **"Attended = TRUE"** if they meet **ANY** of these criteria:

- Spoke ≥ `ACTIVE_WORDS_MIN` words
- OR spoke for ≥ `ACTIVE_DURATION_MIN_SEC` seconds
- OR asked ≥ `ACTIVE_QUESTIONS_MIN` questions

### Confidence Scoring

The system provides confidence scores (0.1-1.0) based on:

- **Words spoken** (40% weight)
- **Speaking duration** (40% weight)
- **Questions asked** (20% weight)

## API Reference

### Fireflies GraphQL

The worker queries these fields from Fireflies.ai:

```graphql
query GetTranscript($id: ID!) {
  transcript(transcript_id: $id) {
    transcript_id
    title
    date
    duration_seconds
    transcript_url
    participants # array of emails
    speakers {
      id
      name
    }
    analytics {
      speakers {
        name
        user_id
        user_email
        word_count
        questions
        duration_sec
        duration_pct
        words_per_minute
      }
    }
  }
}
```

### Webhook Payload

The worker expects Fireflies webhooks with:

- `transcript_id` (or nested under `data`)
- `type: "ping"` for health checks

## Development

```bash
# Local development
npm run dev

# Deploy to production
npm run deploy

# View logs
wrangler tail
```

## Troubleshooting

### Common Issues

1. **"No transcript yet"**: Webhook arrived before analytics were ready
2. **"Analytics unavailable"**: Basic Fireflies plan may not include speaker analytics
3. **Sheets permission errors**: Ensure service account has edit access to the sheet

### Debugging

Check Cloudflare Workers logs:

```bash
wrangler tail --format=pretty
```

## Advanced Configuration

### Mark Presence as Attendance

To treat "present in participant list" as attended, modify the fallback logic in `determineAttendance()`.

### Team/User Filtering

Add filters to the GraphQL query to limit to specific teams or users.

### Retry Logic

For production use, consider adding retry logic for webhooks that arrive before analytics are ready.

## License

MIT
