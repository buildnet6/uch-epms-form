# UCH EPMS details form

Nurses fill one short form, pay the service fee through Flutterwave, and their details are stored in Supabase.
The full EPMS workbook (performance contract, 12 monthly reviews, 4 quarterly appraisals) is then generated from each paid submission.

## What's where

| Part | Location |
|---|---|
| The form (this site) | `index.html`, served by GitHub Pages |
| Backend (save, edit link, payment check) | Supabase edge function `epms-form` in project `myebhfkovfmltoirptrl` (source in `supabase/functions/epms-form`) |
| Submissions | Supabase table `public.epms_submissions` (view: `epms_submissions_overview`) |
| Workbook filler | `kit/fill_epms.py` + `kit/blank_master.xlsx` |
| One-page summary PDF | `kit/summary_pdf.py` |

## One-time setup

1. **GitHub Pages**: repo Settings > Pages > Source: `Deploy from a branch`, branch `main`, folder `/ (root)`.
2. **Flutterwave public key**: in `index.html`, replace `__FLW_PUBLIC_KEY__` with your public key (`FLWPUBK-...`).
3. **Flutterwave secret key** (never put it in this repo): Supabase dashboard > Edge Functions > Secrets > add
   - `FLW_SECRET_KEY` = your Flutterwave secret key (`FLWSECK-...`)
   - `FLW_SECRET_HASH` = any long random phrase you choose
4. **Flutterwave webhook** (backup confirmation): Flutterwave dashboard > Settings > Webhooks
   - URL: `https://myebhfkovfmltoirptrl.supabase.co/functions/v1/epms-form/webhook`
   - Secret hash: the same phrase as `FLW_SECRET_HASH`
5. Optional: add secret `EPMS_ALLOWED_ORIGIN` = your Pages address (e.g. `https://yourname.github.io`) so only your form can call the backend.

Until step 3 is done the form still saves submissions and tells nurses payment will be arranged separately.

## Seeing submissions

Supabase dashboard > Table editor > `epms_submissions` (or the `epms_submissions_overview` view). `payment_status = paid` rows are ready to fill; `filled_at` is set once a workbook has been generated.

## Generating workbooks (what Claude runs)

```sql
select id, data from public.epms_submissions where payment_status = 'paid' and filled_at is null order by paid_at;
```
Save each `data` to `<id>.json`, then:
```bash
python kit/fill_epms.py *.json --out out
python kit/summary_pdf.py *.json --out out   # one-page summary for each nurse
```
Then mark them done:
```sql
update public.epms_submissions set filled_at = now(), fill_notes = '<notes>' where id in (...);
```


## Admin dashboard

`admin.html` (https://buildnet6.github.io/uch-epms-form/admin.html) shows every submission, what needs attention
(overdue, to generate, ready to send, payment problems, quiet starters), an activity log and per-nurse details and actions.
It signs in with the admin passcode, which is stored only as a PBKDF2 hash in `epms_admin`; 8 wrong tries from one
address pause sign-in for 15 minutes. The passcode can be changed from the dashboard.

When workbooks are generated, set `filled_at` on the submission so the dashboard moves it to "Ready to send".
