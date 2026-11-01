# AA Book Pilot Client Config Templates (`templates/`)

Every AA Book client install is configured by copying or generating six plain JSON files inside the gitignored `client/` folder (`business.json`, `services.json`, `staff.json`, `persona.json`, `policies.json`, and `channels.json`).

This directory contains three starter packs:

| Pack | Purpose | Ready to Load As-Is? |
| :--- | :--- | :--- |
| `templates/blank/` | Complete blank client pack where every answer required from the shop owner is marked with a `TODO:` placeholder. | **No** — replace every `TODO:` first (`aabook status` lists any remaining `TODO` fields). |
| `templates/fort-smith-hvac/` | Fully worked fictional example matching the **Fort Smith Heating & Air** demo shop (`aabook demo`). | **Yes** — passes `aabook status` immediately with zero edits. |
| `templates/home-inspection/` | Fictional pilot-trade example (**Sample Ridge Home Inspections**) with `business.json`, `staff.json`, `persona.json`, `policies.json`, and `channels.json` pre-shaped for residential home inspections, and `TODO:` placeholders in `services.json`. | **After owner service intake** — fill in `services.json` from the owner's real menu first. |

---

## Using a Template Pack for a Client Install

1. Copy the chosen template pack into the local `client/` directory (which is gitignored so real client details never enter git):
   ```bash
   cp -R templates/home-inspection/. client/
   ```
   *(Or start from `templates/blank/.` for any other trade.)*

2. Replace every `"TODO: ..."` value with answers confirmed directly by the business owner.
   - Ensure numeric fields (`durationMinutes`, `price`, `bufferMinutes`, `noticePeriodHours`, `fee`, `amount`, `dailySpendCapUsd`) are saved as JSON numbers (not quoted strings) and boolean fields (`closed`, `required`, `requiresDeposit`, `allowOnlineBooking`) are saved as `true` or `false`.

3. Run `aabook status` to verify:
   ```bash
   aabook status
   ```
   AA Book's config validator automatically rejects any unresolved `TODO` placeholder so an incomplete template cannot go live by mistake.

---

## Non-Negotiable Rules

1. **No real business data in `templates/`.** Everything committed under `templates/` uses fictional names, addresses, and reserved `555-01xx` phone numbers. Real client files belong only in the local gitignored `client/` folder on that client's machine.
2. **Never scrape a client's website for `services.json`.** Especially for home inspection companies—where square-footage tiers, older-home surcharges, inspection durations, and add-ons (radon, termite/WDI, sewer scope, well/septic) often differ from outdated website copy—the services list and pricing **must** come directly from the owner.
3. **Secrets go in `.env` only, never in templates or `client/*.json`.** Keep `WEBHOOK_SECRET`, model API keys, voice/SMS keys, and Google Calendar credentials strictly in `.env`. AA Book's config validator rejects secret-named keys inside client JSON files.
