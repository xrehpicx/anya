# anya

cheaper jarvis

**Disclaimer: This project is in no way intended for production use. It is an experimental project that I have made for myself to see how far I can push LLM models to manage my tools for me. A lot of the code does not follow standard best practices as my priority was experimentation rather than production readiness. Over time, I plan to slowly refine this project, making it better and easier for others to use and contribute.**

Current Abilities:

- Multi user support.
- Support for discord for user interaction and whatsapp for events.
- Support for voice input through on_voice_message event.
- Support for external events to trigger anya to execute any given instruction.
- Support a schedule to trigger anya to execute any given instruction.
- Can store memories for certain tasks.

Current Tools & Managers:

- Calculator: Can perform basic arithmetic operations.
- Get time: Can tell the current time.
- Calendar Manager (Uses CALDAV):
  - Can manage a user's calendar. (not yet configurable per user).
- Cat Images: Can fetch random cat images.
- Chat search: Can search for a chat message in a convo.
- Communications Manager
  - Send Email: Can send an email to a user.
  - Send Message: Can send a message to a user. (supported platforms: discord, whatsapp)
- Docker Container Shell: Can execute shell commands in an isolated docker container.
- Events Manager
  - CRUD on Events: Setup events that can be listened to. (webhook based, need a one time manual setup for each event).
  - CRUD on Event Listeners: Setup event listeners that can call anya with a given instruction. once that event is triggered.
- Files Tools (Currently disabled by default)
  - CRUD on a single s3/minio bucket.
- Goole Search (Currently disabled): Can search google for a given query.
- Home Assistant Manager:
  - Can update Services: Can run services to control devices on a home assistant instance.
- LinkWarden Manager:
  - CRUD on Links: Manage links on a linkwarden instance.
- Meme Generator: Can generate memes.
- Memory Manager:
  - CRUD on Memories: Manage memories for anya and other managers.
- Notes Manager:
  - CRUD on Notes: Manage notes with a defined template using webdav to perform crud on respective markdown notes files.
- Periods Tools:
  - Period Tracking tools: can track cycles for a user.
  - Mood tracker per cycle: Can save mood events in an ongoing cycle.
  - Search: Can search through for events since the beginning of all tracking.
- Reminder Manager (Uses CALDAV):
  - CRUD on Reminders: Manage reminders for a user.
- Scraper (currently disabled): Can scrape a given website for a given query.
- Services Status: Can check the status of a given service.
- Youtube Tools:
  - Summerization: Can summerize a youtube video.
  - Searching in Video: Can search for a query in a youtube video.
  - Download: Can download a youtube video.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.0.11. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
