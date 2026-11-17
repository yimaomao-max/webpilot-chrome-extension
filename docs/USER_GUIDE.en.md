# WebPilot AI User Guide (detailed)

> Extended companion to [README.en.md](../README.en.md). Use for onboarding, help centers, or training.

**Languages:** [English](USER_GUIDE.en.md) · [简体中文](USER_GUIDE.md)

## Contents

1. [Product positioning](#1-product-positioning)
2. [UI tour](#2-ui-tour)
3. [Extraction modes](#3-extraction-modes)
4. [Monitor lifecycle](#4-monitor-lifecycle)
5. [Understanding a change record](#5-understanding-a-change-record)
6. [How weekly reports are built](#6-how-weekly-reports-are-built)
7. [FAQ](#7-faq)

---

## 1. Product positioning

WebPilot AI is **not** a generic scraper. It is a **structured monitor for public commercial pages**, especially:

- SaaS **pricing pages** (plan names, prices, seats, billing period)
- **Feature comparison matrices** (Plan A/B/C checkmarks)
- Public **job boards**, **changelog tables**, and other repeating row layouts

Goal: a non-engineer can stand up a **long-lived comparable** monitor in about three minutes.

---

## 2. UI tour

### Popup

| Area | Purpose |
|------|---------|
| Quota (header) | Plan limit vs monitors in use |
| Smart pick / Scan tables | Extract from the active tab |
| Preview | Editable column names—verify empty/wrong rows before confirming |
| Field panel | AI or rule types; **Confirm fields** locks semantics for monitoring |
| Add from URL | Scan a URL without opening it first |
| Monitor list | Last check time, status, link to report |

### Options

- **AI**: base URL, key, model—all local
- **Cloud bind**: pairing code syncs plan limits
- **Webhook**: change notifications + test button
- **Local plan simulation**: Free/Pro/Team when not bound to cloud

---

## 3. Extraction modes

### 3.1 Table mode (`mode: table`)

Triggered when the pick target is a `<table>` or you choose a scanned table.

- Uses `tableSelector` for the full table
- Parses `thead` / first-row headers and `tbody` rows
- Best for classic HTML pricing tables

### 3.2 List / pick mode (`mode: pick`)

Triggered when you click cards, pricing columns, feature rows, or other **repeated DOM** patterns.

- `findGroup` walks up to find ≥3 sibling elements with the same tag → list container
- Derives per-field selectors from a sample item
- Fits Tailwind / div-based pricing layouts without `<table>`

### 3.3 Paginated batch extract

Requires a successful extract and `wp_draft.config`.

- Finds “next page” links (common EN/ZH labels + `rel=next`)
- **Keep the tab open** until `wp_paginationJob.status === 'done'`
- Default 10 pages, max 200—avoid hammering small sites

---

## 4. Monitor lifecycle

```text
Create monitor
   → Register chrome.alarm (wp-mon-{id})
   → On fire: checkMonitor
        → fetch URL (no credentials)
        → offscreen parse
        → field alignment
        → diffRows
        → no meaningful delta: update lastRows only
        → meaningful delta: wp_changes, badge, webhook
   → User can delete / change interval (subject to plan minIntervalMin)
```

### `lastStatus` values

| Status | Meaning | Suggested action |
|--------|---------|------------------|
| `ok` | Last check succeeded | — |
| `checking` | In progress | Wait |
| `selector_broken` | Selector failed with prior history | Re-pick and update monitor config |
| `needsReconfigure` flag | Degraded extract succeeded | Page redesign—re-confirm fields |

---

## 5. Understanding a change record

Each entry in `wp_changes[monitorId]` includes:

| Field | Description |
|-------|-------------|
| `summary` | Human-readable bullet lines |
| `fieldChanges` | Machine-readable with `change_type` |
| `insight` | `facts` + `guess` + `category` |
| `added` / `removed` / `modified` | Raw diff samples (capped) |

Price changes emit `price_increase` / `price_decrease` when the column is `type: price` or values look like currency—ready for BI or Zapier.

---

## 6. How weekly reports are built

1. `buildWeekRaw` collects changes from the last 7 days  
2. Groups sections by `competitorOf(url)` (domain)  
3. Rules layer writes Markdown overview and per-competitor sections  
4. If LLM is configured and there were changes, optional business narrative (rules-only fallback on failure)  

Alarm: `wp-weekly-report`, 7-day period; or **Generate now** in the popup.

---

## 7. FAQ

### Q: Dynamic SPA—no tables found?

A: Use **Smart pick** after the page fully loads. Background monitors on heavy SPAs may need more frequent re-picking.

### Q: Monitor says no change but I see a difference?

A: Change might be outside monitored fields (images, decorative copy), or predates the monitor. Check for `selector_broken`.

### Q: Will my API key leak?

A: Keys live in extension local storage; requests go from your browser to your configured base URL. Don’t screen-record the Options page.

### Q: vs Puppeteer / Playwright?

A: WebPilot targets **low friction + field-level business semantics + built-in diff/insights**—not fleet-scale crawling—for PMs and growth folks watching public competitor pages.

---

For architecture and modules, see [README.en.md](../README.en.md).