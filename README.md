# King of the Court — Retro Vertikal Tennis (Multiplayer)

Ett kommersiellt 2D vertikalt retro-tennisspel i "King of the Hill"-format,
byggt med Node.js, Express och Socket.io. Fyra banor (Melbourne, Paris,
London, New York), var och en med egen spelarkö. De två första i kön möter
varandra — Kungen längst ner, Utmanaren längst upp — medan alla andra ser
matchen live i åskådarläge tills det är deras tur.

## Funktioner

- Realtidsmultiplayer via WebSockets (Socket.io)
- 4 oberoende banor/rum, var och en med egen kö, matchstate och boll-fysik
- Automatisk kö-hantering: vinnaren stannar/blir Kung, förloraren går bakerst i kön
- Alla icke-spelande deltagare är automatiskt åskådare och ser positioner,
  poäng, servebesked och kö-status strömmas live
- **Matchstart-flöde:** när två spelare är redo triggas ett `match-start-event`
  med slantsingling (krona/klave) som avgör vem som servar först. En låst
  30-sekunders nedräkning visas för alla i rummet innan den 5 minuter långa
  match-timern startar.
- **Styrning:** håll inne piltangenterna (↔) för att flytta paddeln.
  Mellanslag krävs för varje serve och retur — ingen automatisk retur sker.
  Ett generöst input-bufferfönster på 300 ms gör vanliga returer förlåtande,
  medan de sista 125 ms närmast bollkontakt ger ett hårt slag.
- **Riktig tennis-poängräkning:** Love/15/30/40/Deuce/Advantage/Game, med
  serverväxling varje nytt game.
- **Matchslut:** vid uppnått games-mål eller när 5-minuterstimern tar slut
  (då avgörs vinnaren av flest games, därefter flest poäng i pågående game).
- **Retro topplista (global):** öppningsbar via en knapp i sidopanelen —
  spelare i kö och åskådare kan läsa den utan att lämna rummet. Visar
  vinster/matcher per spelarnamn, uppdateras automatiskt live när en match
  avgörs.
- **Banrekord (per bana), permanent sparade:** servern håller koll på två
  rekord per bana — "Flest vinster i rad som King" och "Flest minuter som
  King" — och sparar dem till en lokal JSON-fil (`data/court-records.json`)
  så de överlever omstarter. En egen retro-modal ("🏰 BANREKORD") visar alla
  fyra banors rekord, och en alltid synlig live-panel i sidopanelen tickar
  aktuell Kungs segersvit/regeringstid mot rekorden i realtid — perfekt för
  åskådare som väntar i kön. Uppdateras direkt så fort en King förlorar
  kronan eller sätter ett nytt rekord (med egen fanfar och toast).
- **8-bitars ljudeffekter** (Web Audio API, inga ljudfiler behövs): unikt
  larmljud när 30-sekundersnedräkningen startar, vanlig bollträff, hårt
  tajmat slag, poäng-/game-fanfar, samt en extra festlig fanfar när ett
  banrekord slås.
- Startskärm med spelförklaring, val av användarnamn och bana
- Förberedd för miljövariabler (inga hemligheter hårdkodade, se `.env.example`)

## Speltekniska detaljer

- Planstorlek: server-fysiken körs internt i ett 800×600-koordinatsystem;
  klienten ritar allt skalat till en vertikal **400×600 pixlig retro-canvas**
  (`image-rendering: pixelated`, blockiga rektanglar utan rundade hörn, hög
  kontrast mot den nästan svarta bakgrunden)
- Banfärger: Melbourne = blå (`#2f8dff`), Paris = orange (`#ff8c1a`),
  London = grön (`#33d17a`), New York = mörkblå (`#2438b0`)
- Matchflöde: `pregame` (30s lås + coin toss) → `playing` (5 min match-timer,
  server-styrd bollfysik) → `finished` (resultat visas, roller delas om)
- En match vinns av den som först når **4 games med minst 2 games marginal**
  (en förkortad variant av ett set, vald för att hinna avgöras inom
  5-minuterstimern — se kommentarer i `server.js` för fler designbeslut)
- Om servande spelare inte trycker Mellanslag inom 8 sekunder auto-servar
  servern åt dem, så en match aldrig kan fastna
- All spellogik (kollisioner, slag-tajmning, poäng, kö-hantering) körs
  server-side för att förhindra fusk — klienten renderar bara vad servern
  skickar

## Köra lokalt

```bash
npm install
npm start
```

Öppna sedan `http://localhost:3000` i webbläsaren. Öppna gärna flera
flikar/fönster för att testa flerspelarläget själv.

## Distribution till Railway.app

1. Pusha projektet till ett GitHub-repo.
2. Gå till [railway.app](https://railway.app) → **New Project** →
   **Deploy from GitHub repo** → välj repot.
3. Railway känner automatiskt av `package.json` och kör `npm install`
   följt av `npm start`.
4. Railway sätter `PORT` automatiskt — servern lyssnar redan på
   `process.env.PORT` (se `server.js`), så ingen ändring behövs.
5. (Valfritt) Under **Variables** i Railway-projektet kan du lägga till:
   - `CLIENT_ORIGIN` — om frontend någon gång separeras från backend
   - `DATABASE_URL` — om du vill lägga till persistent lagring (topplistor,
     matchhistorik, konton). Se kommentarer i `server.js` för var den ska
     kopplas in.
   - `ANALYTICS_API_KEY` — om du vill koppla på en analystjänst
6. Klicka **Deploy**. Railway ger dig en publik URL, t.ex.
   `https://ditt-projekt.up.railway.app`.

## Projektstruktur

```
├── server.js           # Express + Socket.io-server, spellogik + topplista + banrekord
├── package.json
├── .env.example         # Dokumenterade (ej hårdkodade) miljövariabler
├── .gitignore
├── data/                # Skapas automatiskt av servern — court-records.json
│                         # (banrekorden). Committa inte denna mapp.
└── public/
    └── index.html        # KOMPLETT frontend i en enda fil: CSS, canvas-rendering,
                           # Web Audio-ljud, Socket.io-klient, topplista och
                           # banrekord-overlay — allt inline

```

### Om banrekordens beständighet på Railway

Servern skriver banrekorden till `data/court-records.json` på det lokala
filsystemet. En vanlig omstart/krasch inom samma Railway-deploy behåller
filen. Men Railways standardfilsystem är **ephemeralt vid nya deployer** —
pushar du ny kod (eller Railway roterar containern) börjar filen om från
noll igen. Vill ni att rekorden ska överleva permanent, oavsett deploy,
finns två alternativ:

1. Koppla in en **Railway Volume** monterad på `/app/data` i projektet.
2. Byt ut JSON-filen mot en riktig databas via `DATABASE_URL` (se
   kommentarerna i `server.js` för var den ska kopplas in).

## Nästa steg (kräver miljövariabler — se `.env.example`)

- Persistent topplista / matchhistorik (överlever omstart av servern) → koppla in `DATABASE_URL`
- Analys av spelarengagemang → koppla in `ANALYTICS_API_KEY`
- Låst CORS mot en specifik produktionsdomän → `CLIENT_ORIGIN`
