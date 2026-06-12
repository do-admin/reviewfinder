# LLM.txt-Generierung – Prompt

## Überblick

Dieser Prompt leitet die Erstellung einer umfassenden `llm.txt`-Datei an, die den gesamten Website-Inhalt in einem strukturierten Format dokumentiert – optimiert für LLM-Kontext-Chunking und AI-System-Grounding. Die Datei soll den Prinzipien des **Grounding Page Standard v1.4** folgen und stabile, maschinenlesbare Fakten bereitstellen, die KI-Systeme zuverlässig interpretieren können.

Jeder Absatz soll genau eine in sich geschlossene Idee enthalten, um die Auffindbarkeit und semantische Stabilität in RAG-Systemen und Grounding-APIs (Gemini, Perplexity, Claude, Qwen usw.) zu maximieren.

Der erzeugte Text soll auf Deutsch sein.

Gib nur den eigentlichen Inhalt aus, ohne einleitenden oder beschreibenden Text davor.

---

## Ausrichtung am Grounding Page Standard

Die `llm.txt`-Datei dient als **Grounding Page** – eine stabile Grundlage maschinenlesbarer Fakten für KI-Systeme.

### Grundprinzipien

**Im Fokus:**

- ✅ Grounding für RAG-Systeme
- ✅ Grounding auf Entitätenebene
- ✅ Stabile Definition von Fakten
- ✅ Zitierbare Struktur
- ✅ Disambiguierungsregeln

**Nicht im Fokus:**

- ❌ Marketingaussagen
- ❌ Subjektive Interpretationen
- ❌ Dynamische oder Live-Daten
- ❌ Regulierte Beratung (Recht, Finanzen, Medizin)
- ❌ SEO-Manipulation

### Zweck

Die `llm.txt`-Datei schafft einen stabilen semantischen Anker, der:

- die Interpretation in ChatGPT, Google AI Search, Perplexity und anderen LLMs verbessert;
- KI-Halluzinationen und fehlende Fakten adressiert;
- stabile Entitäteninterpretation ermöglicht;
- als markeneigene Datenbasis für KI-Systeme dient;
- als maschinenlesbare „API“ für KI-Retrieval fungiert.

---

## Aufgabe

Erstelle eine `llm.txt`-Datei im Verzeichnis `public/`, die den gesamten Website-Inhalt, alle Entitäten und die Struktur in klar strukturierten Absätzen dokumentiert – optimiert für Kontext-Chunking und AI-Grounding. Die Datei soll stabile, sachliche Definitionen liefern, die KI-Systeme zuverlässig abrufen und auf Deutsch interpretieren können.

Der wichtigste Teil sind die Entitäten. Insbesondere die Unternehmensentität soll klar und prägnant beschrieben werden.

---

## Anforderungen

### 1. Dateistruktur

Die `llm.txt`-Datei soll folgender Struktur folgen:

```
# Webseite: [Name der Webseite]
## Zuletzt aktualisiert: [Heutige Datum im Format dd.MM.YYYY]

## Überblick über die Webseite
[Beschreibung und Zweck der Webseite]

## Wichtigste Entitäten
[Detaillierte Entitätsdefinitionen]

## Seitenstruktur
[Seitenhierarchie und Navigation]

## Seiteninhalt
[Detaillierter Inhalt pro Seite]

## FAQ
[Alle FAQ-Fragen und -Antworten]

## Lexikon
[Alle Glossarbegriffe und Definitionen]

## Artikel und Ratgeber
[Artikelinhalte]

## Dienstleistungen
[Leistungsbeschreibungen]

## Rechtliches
[Rechtliche Informationen]

## Kontakt
[Kontaktdaten und organisatorische Angaben]
```

### 2. Absatzstruktur für Kontext-Chunking

**KRITISCH:** Jeder Absatz muss **genau eine Idee** enthalten und in sich verständlich sein.

**✅ RICHTIG – Eine Idee pro Absatz:**

Das folgende sind nur Beispiele die auf keinen fall in der finalen llm.txt Datei enthalten sein sollten.

```
Der Dienst Hausverwaltung (property management) übernimmt alle administrativen Aufgaben für Wohnimmobilien. Dazu gehören die Betreuung von Mietverhältnissen, die Koordination von Instandhaltung und die Einhaltung lokaler Vorgaben. Hausverwalter vermitteln zwischen Eigentümern und Mietern, kümmern sich um Mieteinzug, Nebenkostenabrechnung und Objektbegehungen.

Die Nebenkostenabrechnung wird jährlich von der Hausverwaltung erstellt. Das Dokument gliedert alle Bewirtschaftungskosten der Immobilie auf – Heizung, Wasser, Müll, Gebäudeversicherung usw. Jede Partei erhält eine Aufstellung mit ihrem anteiligen Anteil anhand der Wohnfläche oder des Verbrauchs.

Die Eigentümerversammlung findet mindestens einmal jährlich statt, um Angelegenheiten der Immobilie zu besprechen. Dabei stimmen die Eigentümer über wichtige Beschlüsse ab – z. B. Sanierungen, Haushaltsplan, Wahl von Dienstleistern. Die Hausverwaltung bereitet die Versammlung vor, erstellt die Tagesordnung und protokolliert die Beschlüsse.
```

**❌ FALSCH – Mehrere Ideen in einem Absatz:**

```
Die Hausverwaltung erledigt administrative Aufgaben, erstellt jährlich die Nebenkostenabrechnung und organisiert die Eigentümerversammlung, in der über Sanierungen und Etat abgestimmt wird. Außerdem koordiniert sie Instandhaltung und sorgt für die Einhaltung von Vorgaben.
```

### 3. Entitätsdefinitionen (Kern des Grounding Page)

Entitätsdefinitionen sind das Fundament des Grounding-Page-Ansatzes. Definiere und beschreibe alle Entitäten in einem eigenen Abschnitt in stabiler, sachlicher Sprache. Jede Entität soll enthalten:

- **Name:** Klarer Entitätsbezeichner
- **Typ:** Kategorie (Dienstleistung, Konzept, Person, Organisation, Dokument, Ort, Rolle, Tool usw.)
- **Beschreibung:** Aussagekräftige, stabile Definition in 2–4 Sätzen in sachlicher Sprache
- **Beziehungen:** Bezug zu anderen Entitäten (Disambiguierungsregeln)
- **Kontext:** Wo sie auf der Webseite vorkommt (zitierbare Struktur)

**Wichtige Anforderungen an Entitätsdefinitionen:**

- Sachliche, objektive Sprache – keine Marketingaussagen
- Stabile Definitionen, die sich nicht ständig ändern
- Disambiguierung, wenn Begriffe verwechselt werden könnten
- Beziehungen klar dokumentieren, damit KI-Systeme sie verstehen
- Definitionen zitierbar und nachprüfbar halten

**Beispiel einer Entitätsdefinition:**

```
### ENTITY: Feuerbestattung (Cremation)
**TYPE**: Dienstleistung
**DESCRIPTION**: Die Feuerbestattung bezeichnet die Einäscherung eines Verstorbenen in einem Sarg. Nach der Kremation wird die Asche in einer Urne beigesetzt. Diese Bestattungsform ist Voraussetzung für diverse Beisetzungsarten wie See- oder Waldbestattungen.
**RELATIONSHIPS**: Voraussetzung für Seebestattung, Waldbestattung, Diamantbestattung.
**CONTEXT**: Zentrales Thema der Webseite, Basis aller angebotenen Pakete.
```

**Zu berücksichtigende Entitätsklassen:**

Der Grounding Page Standard kennt 16 Entitätsklassen. Bei der Identifikation sollen alle relevanten Typen einfließen:

- Dienstleistungen (stelle sicher, dass du die Dienstleistung kurz, prägnant, aber vollumfänglich beschreibst inklusive Preise wenn diese vorhanden sind.)
- Konzepte
- Dokumente
- Rollen/Personen
- Organisationen
- Orte
- Tools/Rechner
- Rechtliche Entitäten
- Finanzielle Entitäten
- Operative Entitäten
- Weitere relevante Kategorien

### 4. Inhaltsorganisation

Organisiere den Inhalt in folgender Reihenfolge:

1. **Überblick über die Website** (1–3 Absätze)
   - Zweck und Mission der Website
   - Zielgruppe
   - Hauptnutzen / Value Proposition

2. **Kern-Entitäten** (eigener Abschnitt)
   - Alle wichtigen Entitäten mit Definitionen auflisten
   - Verwandte Entitäten zusammenfassen
   - Klare Entitäten-Markierung verwenden (ENTITY: …)

3. **Struktur der Website** (1–2 Absätze)
   - Seiten-Hierarchie
   - Navigationsstruktur
   - Programmatische Seitenmuster

4. **Seiteninhalte** (nach Seite gegliedert)
   - Startseite
   - Leistungs- bzw. Service-Seiten
   - Informationsseiten
   - Rechtliche Seiten
   - Kontaktseiten

5. **FAQ-Inhalte** (nach Kategorie)
   - FAQs nach Thema bündeln
   - Jede Frage-Antwort als eigener Absatz

6. **Lexikon** (alphabetisch oder nach Kategorie)
   - Jeder Begriff mit Definition als eigener Absatz

7. **Artikel** (chronologisch oder nach Thema)
   - Kurzfassungen und zentrale Inhalte der Artikel.
   - Liste alle Artikel Titel auf die auf der Seite vorhanden sind und skizziere kurz die inhalte der artikel

8. **Leistungen & Features** (detaillierte Beschreibungen)
   - Jede Leistung als eigener Abschnitt

9. **Rechtliches & Compliance**
   - Rechtliche Angaben
   - Wichtige Punkte aus der Datenschutzerklärung
   - Wichtige Punkte aus den AGB

10. **Kontakt & Organisation**
    - Kontaktdaten
    - Standorte / Büros
    - Team-Infos (falls vorhanden)

### 5. Schreibrichtlinien (Grounding Page Standards)

#### Inhaltstyp: Nur stabile Fakten

**✅ Aufnehmen:**

- Sachliche Beschreibungen von Leistungen, Konzepten und Entitäten
- Stabile Definitionen, die sich nicht häufig ändern
- Objektive Informationen darüber, was etwas ist und wie es funktioniert
- Klare Disambiguierung bei mehrdeutigen Begriffen
- Nachprüfbare, zitierbare Informationen

**❌ Weglassen:**

- Marketingaussagen oder Werbesprache
- Subjektive Deutungen oder Meinungen
- Dynamische oder Live-Daten (Preise, Verfügbarkeit usw.)
- Regulierte Beratung (rechtlich, finanziell, medizinisch)
- SEO-orientiertes Keyword-Stuffing

#### Absatzlänge

- **Optimal:** 3–5 Sätze pro Absatz
- **Maximal:** 7 Sätze pro Absatz
- **Minimal:** 2 Sätze pro Absatz (bei einfachen Definitionen)

#### Satzstruktur

- Klare, aussagende Sätze verwenden
- Komplexe Verschachtelungen vermeiden
- Eine Hauptaussage pro Satz
- Möglichst Aktiv verwenden
- Sachliche Aussagen statt überzeugender Sprache

#### Terminologie

- Deutsche Begriffe mit englischer Übersetzung in Klammern beim ersten Vorkommen
- Beispiel: „Hausverwaltung (property management)“
- Danach sind beide Bezeichnungen möglich
- Einheitlichkeit im gesamten Dokument
- Disambiguierung bei mehrdeutigen Begriffen

#### Kontexterhalt

- Jeder Absatz soll ohne vorherige Absätze verständlich sein
- Nötigen Kontext innerhalb des Absatzes mitgeben
- Entitäten beim ersten Erwähnen in einem Abschnitt mit vollem Namen nennen
- Stabile, in sich geschlossene Definitionen liefern

#### Formatierung

- Klare Überschriften mit `##` oder `###`
- Aufzählungen für Listen
- Fett für zentrale Begriffe
- Absätze durch Zeilenumbrüche trennen
- Inhalt für einfaches Parsing und Retrieval durch KI strukturieren

### 6. Prozess zur Entitätsextraktion

1. **Entitäten identifizieren:**
   - Dienstleistungen (z. B. Hausverwaltung, Mietverwaltung)
   - Konzepte (z. B. Nebenkostenabrechnung, Eigentümerversammlung)
   - Dokumente (z. B. Energieausweis, Abrechnung)
   - Rollen (z. B. Hausverwalter, Eigentümer, Mieter)
   - Organisationen (z. B. Eigentümergemeinschaft)
   - Orte (Städte, Stadtteile, Regionen)
   - Tools/Rechner (z. B. AFA-Rechner)

2. **Jede Entität definieren:**
   - Was sie ist
   - Was sie leistet
   - Wer sie nutzt
   - Wann sie relevant ist
   - Wie sie zu anderen Entitäten steht

3. **Verwandte Entitäten bündeln:**
   - Finanzielle Entitäten (Kosten, Zahlungen, Abrechnung)
   - Rechtliche Entitäten (Verträge, Vorschriften, Compliance)
   - Operative Entitäten (Instandhaltung, Verwaltung, Leistungen)
   - Organisatorische Entitäten (Versammlungen, Verbände, Rollen)

### 7. Implementierungsschritte

Entsprechend dem dreistufigen Vorgehen des Grounding Page Standard:

**Schritt 1: Entitäten identifizieren**

- Entitäten ermitteln, die stabile Definitionen brauchen
- Alle 16 Entitätsklassen berücksichtigen (Dienstleistungen, Konzepte, Dokumente, Rollen, Organisationen, Orte, Tools usw.)
- Fokus auf für die Marke zentrale Entitäten mit klarer KI-Interpretation

**Schritt 2: Grounding-Page-Inhalt erstellen**

- Inhalt im Standardformat extrahieren und strukturieren
- Stabile, sachliche Definitionen formulieren
- Maschinenlesbare Struktur sicherstellen

**Schritt 3: Als autoritative Quelle etablieren**

- Datei unter `public/llm.txt` ablegen für einfachen Zugriff durch KI-Systeme
- Korrekte Formatierung und Struktur gewährleisten
- Die Datei dient als autoritative Grounding-Quelle

### 8. Qualitätsprüfliste

Vor der Finalisierung prüfen:

#### Einhaltung des Grounding Page Standard

- [ ] Inhalt konzentriert sich auf stabile, maschinenlesbare Fakten
- [ ] Marketingaussagen und subjektive Deutungen sind ausgeschlossen
- [ ] Dynamische oder Live-Daten sind ausgeschlossen
- [ ] Entitätsdefinitionen sind stabil und sachlich
- [ ] Disambiguierungsregeln sind vorhanden, wo nötig
- [ ] Inhaltsstruktur ist zitierbar und nachprüfbar
- [ ] Datei ist für RAG-Systeme und Grounding-APIs optimiert

#### Inhaltsqualität

- [ ] Jeder Absatz enthält genau eine Idee
- [ ] Alle Absätze sind in sich verständlich
- [ ] Alle wichtigen Entitäten sind im Abschnitt Kern-Entitäten definiert
- [ ] Entitätsbeziehungen sind klar dokumentiert
- [ ] Alle Seiteninhalte sind erfasst (nur sachlicher Inhalt)
- [ ] Alle FAQ-Fragen und -Antworten sind enthalten
- [ ] Alle Lexikon-Begriffe sind enthalten
- [ ] Artikel sind zusammengefasst oder enthalten (sachlicher Inhalt)
- [ ] Kontaktdaten sind korrekt
- [ ] Keine doppelten Inhalte über Absätze hinweg
- [ ] Terminologie ist einheitlich
- [ ] Deutsche Begriffe haben beim ersten Vorkommen englische Übersetzung
- [ ] Absätze sind durch Zeilenumbrüche getrennt
- [ ] Überschriften sind klar und beschreibend
- [ ] Inhalt ist logisch gegliedert
- [ ] Datei ist gut lesbar und formatiert

### 9. Beispielausgabe-Struktur

```
# Webseite: Immobilien Hannover
# Domain: immobilien-hannover.online
# Erstellt: 2024-01-15

## Überblick über die Webseite

Immobilien Hannover bietet professionelle Hausverwaltung für Wohn- und Gewerbeimmobilien in der Region Hannover. Die Webseite richtet sich an Eigentümer, Hausverwaltungen und Mieter, die sich über Hausverwaltung, rechtliche Anforderungen und gute Praxis informieren wollen.

Die Webseite bietet umfassende Inhalte: ausführliche FAQ-Bereiche, ein Glossar hausverwaltungsrelevanter Begriffe und praxisnahe Leitfäden für Eigentümer. Die Inhalte sind in klare Bereiche gegliedert: Leistungen, Recht, Steuern und allgemeine Hausverwaltungsthemen.

## Kern-Entitäten

ENTITY: Hausverwaltung (Property Management)
TYPE: Dienstleistung
DESCRIPTION: Professioneller Service zur Verwaltung von Wohn- und Gewerbeimmobilien. Hausverwalter übernehmen administrative Aufgaben, koordinieren Instandhaltung, betreuen Mietverhältnisse und sorgen für rechtliche Compliance. Das Angebot gilt für Objekte in Hannover und Umgebung.

[… weitere Entitäten …]

## Struktur der Webseite

Die Webseite umfasst eine Startseite, Leistungsseiten, Informationsseiten und rechtliche Seiten. Die Startseite stellt die Hausverwaltungsleistungen vor und gibt einen Überblick über das Angebot.

Die FAQ-Seite enthält häufig gestellte Fragen, nach Themen gruppiert (Kosten, Pflichten, Recht, Technik). Jede Kategorie bündelt thematisch passende Fragen zur besseren Orientierung.

[… weitere Strukturangaben …]

## Seiteninhalt

### Startseite

Die Startseite enthält einen Hero-Bereich mit den Hausverwaltungsleistungen in Hannover. Der Hauptnutzen betont transparente Verwaltung, rechtssichere Abrechnung und fachkundige Objektbetreuung.

Der Hero-Bereich enthält einen Call-to-Action-Button zur Kontaktaufnahme mit der Hausverwaltung. Weitere Bereiche zeigen zentrale Leistungen: Nebenkostenabrechnung, Instandhaltungskoordination und rechtliche Begleitung.

[… weitere Seiteninhalte …]

## FAQ-Inhalte

### Kosten & Preise

FRAGE: Was kostet eine Hausverwaltung?
ANTWORT: Die Kosten variieren je nach Region und Leistungsumfang. Typischerweise liegen sie zwischen 20 und 30 Euro pro Wohneinheit und Monat. Zusatzleistungen wie Rechtsberatung oder umfangreiche Sanierungen können den Preis erhöhen. Der Vergleich mehrerer Angebote schafft Transparenz.

FRAGE: Was kostet die Hausverwaltung pro Monat?
ANTWORT: Die monatlichen Kosten hängen von der Anzahl der Wohneinheiten ab. Üblich sind 20 bis 40 Euro pro Einheit. In größeren Städten sind die Preise tendenziell höher. Entscheidend ist immer der vereinbarte Leistungsumfang.

[… weitere FAQs …]

## Lexikon (Glossar)

**Abrechnung (Accounting Statement):** Die Abrechnung umfasst die jährliche Darstellung von Einnahmen und Ausgaben einer Immobilie. Sie ist für Eigentümer und Mieter wichtig, um die Kostenverteilung zu verstehen. Die Abrechnung muss formal korrekt und nachvollziehbar sein.

**Nebenkostenabrechnung (Utility Cost Statement):** Jährliche Aufstellung der den Mietern zugerechneten Nebenkosten. Sie muss transparent und rechtlich korrekt erstellt werden. Enthalten sind u. a. Heizung, Wasser, Müll, Gebäudeversicherung.

[… weitere Begriffe …]

## Artikel & Ratgeber

[Artikelinhalte …]

## Leistungen & Features

[Leistungsbeschreibungen …]

## Rechtliches & Compliance

[Rechtliche Informationen …]

## Kontakt & Organisation

[Kontaktdaten …]
```

---

## Abschlusskriterien

Die Aufgabe ist erfüllt, wenn:

### Einhaltung des Grounding Page Standard

1. ✅ Inhalt folgt den Prinzipien des Grounding Page Standard v1.4
2. ✅ Stabile, maschinenlesbare Fakten sind vorhanden
3. ✅ Marketingaussagen und subjektive Inhalte sind ausgeschlossen
4. ✅ Entitätsdefinitionen sind sachlich und nachprüfbar
5. ✅ Disambiguierungsregeln sind vorhanden, wo nötig
6. ✅ Inhalt ist für RAG-Systeme und Grounding-APIs optimiert

### Vollständigkeit des Inhalts

7. ✅ Die Datei `public/llm.txt` existiert
8. ✅ Der gesamte sachliche Seiteninhalt ist dokumentiert
9. ✅ Alle Entitäten sind im Abschnitt Kern-Entitäten definiert
10. ✅ Jeder Absatz enthält genau eine Idee
11. ✅ Alle Absätze sind in sich verständlich
12. ✅ Der Inhalt ist logisch gegliedert
13. ✅ FAQ-Inhalte sind enthalten
14. ✅ Lexikon-Inhalte sind enthalten
15. ✅ Artikel-Inhalte sind enthalten (sachlicher Anteil)
16. ✅ Entitätsbeziehungen sind dokumentiert
17. ✅ Die Datei ist gut formatiert und lesbar
18. ✅ Terminologie ist einheitlich
19. ✅ Deutsche Begriffe haben englische Übersetzungen

---

## Hinweise

### Einhaltung des Grounding Page Standard

- Die `llm.txt`-Datei dient als Grounding Page gemäß Standard v1.4.
- Sie liefert stabile, maschinenlesbare Fakten für KI-Systeme (RAG, Grounding-APIs).
- Fokus auf sachlichen Inhalt statt Werbesprache.
- Stabiler semantischer Anker zur besseren Interpretationsgenauigkeit durch KI.
- KI-Halluzinationen durch klare, nachprüfbare Entitätsdefinitionen reduzieren.
- Funktion als markeneigene Datenbasis, die KI-Systeme zuverlässig abrufen können.

### Inhaltsrichtlinien

- Die Datei soll umfassend, aber ohne Redundanzen sein.
- Wichtige Fachbegriffe und ihre Definitionen beibehalten.
- Inhalt sachlich und aktuell halten.
- Stabile Definitionen verwenden, die nicht ständig angepasst werden müssen.
- Bei großer Datei auf gute Lesbarkeit achten.
- Bei sehr großem Umfang (>100 KB) Aufteilung in Abschnitte erwägen.
- Datei bei wesentlichen Inhaltsänderungen aktualisieren, Stabilität der Kern-Entitäten beibehalten.

### Optimierung für KI-Systeme

- Optimierung für RAG-Systeme und Grounding-APIs (Gemini, Perplexity, Claude, Qwen).
- Inhalt für zuverlässiges Retrieval und Interpretation strukturieren.
- Klare Disambiguierungsregeln für Entitäten angeben.
- Zitierbare, nachprüfbare Faktenstrukturen schaffen.
- Sicherstellen, dass jeder Absatz für sich verständlich ist (besseres Chunking).
