# Local Gmail and Notion Evidence Adapter

## Decision boundary

Gmail and Notion are enabled as local integration targets, but AIOS access remains read-only and explicitly authorized. The adapters do not send email, create or update Notion pages, or write external content into Founder Memory. Results are raw evidence returned to the caller; no automatic promotion, summarization, or permanent-memory write occurs.

The local Obsidian++ application is the credential boundary. It owns Google OAuth tokens and the Notion integration token in its owner-only local configuration. AIOS receives only the Obsidian++ local API password and never receives or stores the provider credentials themselves. ChatGPT-connected Gmail and Notion sessions are not runtime credentials and cannot be exported into the local process.

## Endpoints

The adapter accepts only an explicit-port IPv4 loopback URL, defaulting to `http://127.0.0.1:4444`, and uses authenticated GET requests:

- `GET /api/connectors/gmail/search?query=...` — at most five message metadata/snippet records; Gmail scope is `gmail.readonly`.
- `GET /api/connectors/notion/applications` — at most 500 job-application records from the configured Notion database.

Redirects are rejected. Requests have a bounded timeout. Provider errors, malformed payloads, invalid identifiers, and oversized results fail closed.

## Authorization

Gmail and Notion have separate resource UUIDs. Before any network request, the adapter calls the shared FounderAuthorizationPort with:

- authenticated actor supplied by the trusted local host
- action `read_evidence`
- the corresponding Gmail or Notion resource UUID

A denial or authorization error prevents the HTTP request. There is no implicit owner grant, wildcard permission, or fallback. Configure separate resource policies so access to Gmail does not imply access to Notion or the vault.

## Provenance

Gmail source IDs are deterministic UUIDv5 values derived from the Gmail resource UUID and provider message ID. Notion source IDs use the Notion resource UUID and stable Notion page ID. Provider IDs are retained as source references.

The Notion bridge requires the local Obsidian++ route to include each page's stable `id`. The Notion database ID is configurable through `NOTION_JOB_APPLICATIONS_DATABASE_ID`; the current workspace's Job Applications database ID is the example default in Obsidian++ `.env.example`.

## Local configuration

Obsidian++ must be configured separately:

- Google OAuth client ID, secret, and exact loopback redirect URI. Gmail authorization requests only `gmail.readonly`; OAuth state is one-time and time-limited.
- A Notion integration token shared only with the Job Applications database.
- The Notion database ID, if different from the example default.
- The local Obsidian++ password, generated and stored in the owner-only `.env`.

AIOS host configuration additionally requires two distinct UUIDs for the Gmail and Notion resources and explicit policies for the intended actors. Do not put provider tokens in source control, AIOS entity records, prompts, or chat messages.

## Verification status

Unit tests cover loopback URL enforcement, distinct resource IDs, authorization-before-network, authenticated no-redirect GET requests, payload bounds, malformed responses, and stable source IDs. These tests use mocked HTTP responses. They do not establish that the user's local Gmail OAuth flow or Notion integration has been configured or connected.

## Remaining integration work

The reader adapters and FounderInterface methods are implemented. A trusted local composition root still needs to load validated configuration, attach the two resource policies, and inject the adapter into FounderInterface. Live Gmail and Notion smoke tests require the user to configure provider credentials locally; no secrets are requested or stored through this PR.
