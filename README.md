# King of the Court — Retro Vertical Tennis (Multiplayer)

A 2D retro tennis game in a King of the Hill format, built with Node.js,
Express, and Socket.io. Four courts—Melbourne, Paris, London, and New York—each
have their own player queue. The first two players compete, with the King at
the bottom and the Challenger at the top, while everyone else watches live.

## Features

- Realtime multiplayer via Socket.io
- Four independent courts with separate queues, match state, and ball physics
- Automatic queue management: the winner remains King and the loser returns
  to the back of the queue
- Live spectator mode with positions, scores, serve status, and queue updates
- A 30-second pregame countdown and coin toss followed by a five-minute match
- **Active controls:** hold the arrow keys to move. Space is required for every
  serve and return. A 300 ms input buffer makes ordinary returns forgiving,
  while the final 125 ms before contact produces a power shot.
- Tennis scoring: Love/15/30/40/Deuce/Advantage/Game
- Global leaderboard with wins and matches per player name
- Persistent per-court records stored in `data/court-records.json`
- Eight-bit sound effects generated with the Web Audio API
- Four distinct surfaces with proper tennis markings:
  - Melbourne: blue hard court
  - Paris: red clay
  - London: green grass
  - New York: dark-blue hard court

## Game details

- The server uses an internal 800×600 coordinate system. The client scales it
  to a vertical 400×600 pixel-art canvas.
- Paddle movement, ball physics, collisions, shot timing, scoring, and queue
  management are server-authoritative.
- Match flow: `pregame` → `playing` → `finished`.
- The first player to reach four games with a two-game lead wins the match.
- If the five-minute timer expires, games decide the winner, followed by the
  current game's points and finally a coin toss if still tied.
- If the serving player does not press Space within eight seconds, the server
  automatically launches the serve so a match cannot stall.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`. Use multiple tabs or windows to test multiplayer.

## Deploy on Render

1. Push the project to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com/), create a **Web Service**.
3. Connect the `kingofthecourt` repository.
4. Use `npm install` as the build command and `npm start` as the start command.
5. Render sets `PORT` automatically; the server already listens on
   `process.env.PORT`.
6. Keep automatic deploys enabled for the `main` branch.

## Project structure

```text
├── server.js            # Express + Socket.io server and game logic
├── package.json
├── .env.example         # Documented optional environment variables
├── .gitignore
├── data/                # Generated court-record storage; do not commit
└── public/
    └── index.html       # Complete frontend, canvas, audio, and Socket.io client
```

## Record persistence on Render

Court records are written to `data/court-records.json`. Render's standard
filesystem is ephemeral across deployments, so production records require
either a persistent disk mounted for the data directory or a database connected
through `DATABASE_URL`.

## Optional environment variables

- `CLIENT_ORIGIN`: restrict Socket.io CORS when frontend and backend use
  different origins
- `DATABASE_URL`: persistent leaderboard, records, or match history
- `ANALYTICS_API_KEY`: future analytics integration
