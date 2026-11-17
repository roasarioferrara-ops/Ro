# Friseur-Termine

Eine kleine Webseite zum Buchen von Friseurterminen.

- **Kunden** sehen nur die Termine, die du freigegeben hast, wählen Leistung und Uhrzeit und buchen mit Name und Telefonnummer. Über einen persönlichen Link können sie wieder absagen. Wer eine E-Mail-Adresse angibt, bekommt eine Bestätigung per E-Mail (sobald der Versand eingerichtet ist, siehe unten).
- Kunden werden mit **„du“** angesprochen.
- **Du** hast einen eigenen, passwortgeschützten Bereich unter `/admin`. Kunden sehen davon nichts.

## Was dein Bereich kann

| Bereich | Wofür |
|---|---|
| **Termine** | Alle gebuchten Termine nach Tag sortiert, mit Telefonnummer und Notiz. Vergangene Termine schließt du mit **Erledigt** ab, mit **Nicht erschienen** oder du sagst sie ab. |
| **Freigeben** | Viele Termine auf einmal freigeben (z. B. Di–Fr, 9–18 Uhr, alle 30 Minuten) oder einzelne. Freie Termine kannst du löschen. Wenn jemand anruft, trägst du ihn selbst ein. |
| **Erledigt** | Alle erledigten Termine eines Monats mit Betrag und Summe. Du kannst Kunden ohne Termin (Laufkundschaft) nachtragen. |
| **Statistik** | Umsatz und Anzahl pro Monat und pro Jahr, ein Diagramm, eine Auswertung nach Leistung, einen Vergleich der Jahre und einen Export als CSV-Tabelle (z. B. für die Buchhaltung). |
| **Einstellungen** | Salonname, Begrüßungstext, Impressum/Datenschutz, Leistungen mit Preisen und die Regeln für Buchungen (Vorlauf, wie weit im Voraus, bis wann man absagen kann). |

In die Statistik kommt nur, was du als **Erledigt** markiert hast. Beim Abschließen wird der Preis der Leistung vorgeschlagen, du kannst ihn aber ändern (z. B. mit Trinkgeld).

## Ausprobieren

Du brauchst [Node.js](https://nodejs.org) ab Version 20.

```bash
npm install
npm run demo
```

Dann im Browser öffnen:

- Buchungsseite: http://localhost:3000/
- Dein Bereich: http://localhost:3000/admin (Passwort: `demo`)

Die Demo füllt eine eigene Datenbank (`data/demo.db`) mit Beispieldaten und wird bei jedem Start neu angelegt. Bestätigungs-E-Mails werden in der Demo nicht verschickt, sondern im Terminal-Fenster angezeigt.

## Richtig starten

```bash
npm install
ADMIN_PASSWORD='dein-sicheres-passwort' npm start
```

Oder: `.env.example` nach `.env` kopieren, Werte anpassen und mit `node --env-file=.env server.js` starten.

Einstellungen über Umgebungsvariablen:

| Variable | Bedeutung | Standard |
|---|---|---|
| `ADMIN_PASSWORD` | Passwort für deinen Bereich. **Pflicht**, wenn `NODE_ENV=production` gesetzt ist. | zum Testen `admin` |
| `PORT` | Port der Webseite | `3000` |
| `TIMEZONE` | Zeitzone des Salons | `Europe/Berlin` |
| `DB_PATH` | Speicherort der Datenbank | `./data/salon.db` |
| `TRUST_PROXY` | Anzahl vorgeschalteter Proxys (bei Hostern meist 1) | `1` |
| `PUBLIC_URL` | Adresse der Webseite, z. B. `https://termine.mein-salon.de` (für den Link in der E-Mail) | – |
| `SMTP_HOST`, `SMTP_PORT` | Postausgangsserver deines E-Mail-Anbieters | –, `465` |
| `SMTP_USER`, `SMTP_PASS` | Zugangsdaten des Postfachs, von dem die Bestätigungen kommen | – |
| `MAIL_FROM` | Absenderadresse (wenn anders als `SMTP_USER`) | `SMTP_USER` |

Alle Daten liegen in **einer Datei** (`data/salon.db`). Die solltest du regelmäßig sichern.

## Bestätigung per E-Mail

Wenn `SMTP_HOST` und `PUBLIC_URL` gesetzt sind, bekommt jeder Kunde, der online bucht und eine E-Mail-Adresse angibt, sofort eine Bestätigung:

- Datum, Uhrzeit und Leistung mit Preis,
- den Link zum Absagen,
- einen Kalendereintrag zum Anhängen (`termin.ics`).

Absender ist der Name deines Salons. Die Zugangsdaten (Server, Benutzer, Passwort) bekommst du von deinem E-Mail-Anbieter. Am besten nimmst du ein eigenes Postfach für den Salon. Ohne diese Angaben läuft alles wie bisher, nur ohne E-Mail. Beim Start steht im Protokoll, ob der Versand klappt („E-Mail-Versand bereit.“).

Erinnerungen vor dem Termin gibt es nicht.

## Online stellen

Damit Kunden die Seite erreichen, muss sie auf einem Server laufen, der dauerhaft Dateien speichern kann (wegen der Datenbank). Möglich sind zum Beispiel:

- ein kleiner eigener Server (am besten bei einem Anbieter mit Rechenzentrum in der EU),
- oder ein Hosting-Dienst für Node.js-Apps mit dauerhaftem Speicher (Volume/Disk).

Wichtig dabei:

1. `NODE_ENV=production` und ein sicheres `ADMIN_PASSWORD` setzen.
2. Die Seite nur über **HTTPS** erreichbar machen (bieten die meisten Hoster automatisch an).
3. `DB_PATH` auf den dauerhaften Speicher zeigen lassen.
4. Unter **Einstellungen** dein **Impressum** und deine **Datenschutzerklärung** eintragen. Für Webseiten in Deutschland ist das Pflicht. Wenn du Bestätigungs-E-Mails verschickst, gehört auch das in die Datenschutzerklärung.

Die Seite lädt keine fremden Schriften oder Skripte (kein Google Fonts usw.), damit keine Kundendaten an Dritte gehen.

## Technik

- Node.js mit Express, Datenbank SQLite (`better-sqlite3`), E-Mails mit `nodemailer`
- Oberfläche: einfaches HTML, CSS und JavaScript ohne Build-Schritt (`public/`)
- Funktioniert auf dem Handy und am PC, mit hellem und dunklem Modus
- Tests: `npm test`

```
server.js        Webserver und alle Schnittstellen (API)
db.js            Datenbank-Aufbau
lib.js           Hilfsfunktionen (Zeit, Prüfungen, Geld)
mail.js          Bestätigungs-E-Mail
public/          Buchungsseite (index.html, booking.js) und dein Bereich (admin.html, admin.js)
scripts/demo.js  Demo mit Beispieldaten
test/            Automatische Tests
```

Schutzmaßnahmen: Doppelbuchungen werden von der Datenbank verhindert, zu viele Login-Versuche und Buchungen werden gebremst, ein verstecktes Feld hält Spam-Bots ab, und Kunden sehen nie die Daten anderer Kunden.
