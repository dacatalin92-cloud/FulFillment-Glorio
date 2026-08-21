# AWB Glorio — server în timp real

Înlocuiește sistemul vechi bazat pe Claude Artifacts (care se actualiza doar
o dată pe oră) cu un server Node.js propriu care primește un webhook Shopify
în secunde de fiecare dată când se generează un AWB Sameday nou.

## Ce face

- Ascultă webhook-ul Shopify `fulfillments/create`. Când un fulfillment nou
  are curier Sameday, ia detaliile comenzii din Shopify (produse, poze,
  valoare) și salvează AWB-ul în baza de date locală (SQLite).
- Interoghează Sameday la fiecare 2 minute pentru statusul real (ridicat,
  în tranzit, livrat etc.) — doar pentru AWB-urile care nu au încă status final.
- Trimite orice noutate instant, prin WebSocket, către toate paginile
  deschise (stație scanare + dashboard) — fără reîncărcare manuală.
- La fiecare 15 minute rulează și o verificare de siguranță în Shopify
  (backfill), pentru cazul rar în care un webhook s-ar pierde (restart
  server, blip de rețea).
- Paginile `scan.html` și `dashboard.html` rămân accesibile prin link
  direct, fără login — exact ca înainte.

## Pornire locală (test)

```
npm install
cp .env.example .env
# completează .env cu datele reale (vezi mai jos)
npm start
```

Fără `SHOPIFY_SHOP`/`SHOPIFY_ADMIN_TOKEN` setate, serverul pornește oricum,
doar că nu rulează verificarea de siguranță din Shopify (rămâne „webhook-only").

Paginile sunt la `http://localhost:3000/scan.html` și
`http://localhost:3000/dashboard.html`.

## Variabile de mediu

Toate se completează direct în platforma de hosting (Railway/Render), NU se
trimit niciodată prin chat:

- `SHOPIFY_SHOP` — domeniul myshopify.com al magazinului (ex.
  `glorio-ro.myshopify.com`).
- `SHOPIFY_ADMIN_TOKEN` — tokenul Admin API al aplicației custom create în
  Shopify (`shpat_...`). Se generează după instalarea aplicației, din pagina
  aplicației → „API credentials".
- `SHOPIFY_WEBHOOK_SECRET` — Client Secret-ul aplicației (folosit pentru a
  verifica semnătura webhook-ului).
- `SAMEDAY_USERNAME` / `SAMEDAY_PASSWORD` — credențialele contului Sameday API.
- `PORT` — portul pe care ascultă serverul (platforma de hosting îl setează
  de obicei automat).
- `DB_PATH` — opțional, calea fișierului SQLite (implicit `./data.sqlite`
  lângă cod). Pe hosting, ideal pe un disk persistent, ca datele să nu se
  piardă la fiecare redeploy.

## Configurare webhook în Shopify

După ce serverul e deployat și are un URL public (`https://...`):

1. În pagina aplicației custom din Shopify → secțiunea Webhooks (sau prin
   API), adaugă un webhook pentru topicul `fulfillments/create`, format
   JSON, la adresa:
   `https://<domeniul-serverului>/webhooks/fulfillments-create`
2. Verifică din log-urile serverului (`[webhook] new AWB ...`) că
   evenimentele ajung, generând un AWB de test.

## Notă despre fusul orar (de rezolvat înainte de octombrie)

`backfillToday()` din `server.js` calculează începutul zilei curente în
București presupunând ora de vară (+03:00, EEST). Când România trece la ora
de iarnă (+02:00, EET), linia respectivă trebuie actualizată — altfel
verificarea de siguranță ar putea rata AWB-uri generate chiar la începutul
zilei, în intervalul dintre miezul nopții real și miezul nopții calculat
greșit. Nu afectează funcționarea normală prin webhook, doar plasa de
siguranță.

## Structură

- `server.js` — Express + WebSocket + rutele webhook/REST.
- `db.js` — SQLite (better-sqlite3), un rând per AWB.
- `sameday.js` — client API Sameday + polling periodic.
- `shopify.js` — verificare semnătură webhook + interogare GraphQL Admin API.
- `public/scan.html` — stația de scanare.
- `public/dashboard.html` — dashboard-ul cu toate AWB-urile zilei.
