# ITR Hockey — Glove Intake Form

An online version of the ITR Hockey repalming spec sheet. Customers fill out the form, and each
submission becomes a row in a Google Sheet in **your** Google account, with an email notification
to you and a copy to the customer. You then track each order from the sheet.

```
Customer ──▶ Form (GitHub Pages) ──▶ Apps Script web app ──▶ Google Sheet  (orders + status)
                                              └──────────▶ Gmail        (you + customer)
```

Nothing here costs money. You need a Google account (Gmail), a GitHub account, and about 15 minutes.

| Folder         | What it is                                                                 |
| -------------- | -------------------------------------------------------------------------- |
| `web/`         | The intake form, styled to match itrhockeyllc.com. Hosted on GitHub Pages. |
| `apps-script/` | The backend. Saves orders to the sheet, sends emails, tracks status.       |
| `test/`        | Node tests that run the backend against fake Google services.              |

---

## 1. Create the Google Sheet and script

Sign in to Google with the account that should **own the orders and send the emails**.

1. Go to [sheets.new](https://sheets.new) and name the sheet, e.g. *ITR Glove Orders*.
2. Open **Extensions → Apps Script**.
3. Delete everything in `Code.gs`, paste in the contents of [`apps-script/Code.gs`](apps-script/Code.gs), and save (⌘S / Ctrl+S).
4. *(Recommended)* Open **Project Settings** (gear icon), tick **Show "appsscript.json" manifest file**,
   then open `appsscript.json` in the editor and replace it with [`apps-script/appsscript.json`](apps-script/appsscript.json).
   This sets the time zone to US Eastern.

## 2. Set your email

At the top of `Code.gs`:

```js
OWNER_EMAIL: 'you@example.com',
```

- **New-order notifications go to this address.** Any address works, Gmail or not.
- If you set it to `''` (blank), notifications go to the Google account you're signed in as. That's the easiest
  setup for your own personal email, and it keeps your address out of the public GitHub repo (see step 6).
- Emails are always **sent from** the Google account that deploys the script, whatever you set here.

Save again.

## 3. Run setup and deploy

1. In the toolbar's function dropdown, choose **`setup`** and click **Run**.
2. Google asks for permission. Click **Review permissions**, choose your account, then **Advanced → Go to (project name)
   → Allow**. The "unverified app" warning shows up because this is your own script, not a published app.
3. Go back to the sheet. There's now an **Orders** tab with headers, and an **ITR Orders** menu.
4. Back in Apps Script, click **Deploy → New deployment**. Click the gear icon next to "Select type" and choose **Web app**:
   - **Execute as:** Me
   - **Who has access:** Anyone
5. Click **Deploy** and copy the **Web app URL**. It ends in `/exec`.

## 4. Connect the form

Paste the URL into [`web/config.js`](web/config.js):

```js
window.ITR_CONFIG = {
  endpoint: 'https://script.google.com/macros/s/AKfy.../exec',
};
```

## 5. Test it locally

```sh
npm run serve        # then open http://localhost:8080
```

Submit the form and use your own address as the customer email. You should see:

- a new row in the sheet with status **Intake** and an order ID like `ITR-1001`
- a "New glove intake" email to `OWNER_EMAIL` (replying to it goes straight to the customer)
- a confirmation email to the customer address

Then change the row's **Status** to **In Progress**. The Intake Date and Est. Due Date fill in automatically.

The dashed "Demo mode" note on the form means `config.js` has no endpoint yet. In demo mode, nothing is saved.

## 6. Host on GitHub Pages

> **Heads up:** GitHub Pages is free only for **public** repos, so everyone can see the code. That's fine for the
> `/exec` URL, which is public anyway because browsers call it. But if you put your email in `OWNER_EMAIL`, it
> becomes public too. Use `''` (step 2) if you'd rather it didn't.

1. Commit and push to a new GitHub repo. With the [GitHub CLI](https://cli.github.com/):
   ```sh
   git add -A
   git commit -m "Glove intake form"
   gh repo create itr-glove-intake --public --source . --push
   ```
   Or create an empty repo on github.com, then run `git remote add origin <url>` and `git push -u origin main`.
2. On GitHub, open the repo's **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The included workflow ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)) runs the tests and publishes the
   `web/` folder on every push to `main`. Watch it in the **Actions** tab. To start it by hand, open
   **Actions → Deploy form to GitHub Pages → Run workflow**.
4. The form will be live at `https://<your-username>.github.io/itr-glove-intake/`.

Make sure your branch is called `main`. If `git branch` shows `master`, run `git branch -m main` before pushing.

## 7. *(Optional)* Embed it on the Weebly site

On the site's Glove Intake Form page, add an **Embed Code** element:

```html
<iframe id="itr-intake" src="https://<your-username>.github.io/itr-glove-intake/?embed=1"
        style="width:100%;border:0;min-height:1200px" title="Glove Intake Form"></iframe>
<script>
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'itr-intake-height') {
      document.getElementById('itr-intake').style.height = e.data.height + 'px';
    }
  });
</script>
```

`?embed=1` hides the form page's own sidebar, banner, and footer. The script makes the iframe grow to fit the form.

---

## Managing orders

Each order's **Status** column is a dropdown:

`Intake → Confirmed → Waiting on Gloves → In Progress → Completed → Shipped` (or `Cancelled`)

- Moving to **In Progress** (gloves arrived) sets Intake Date to today and Est. Due Date to +28 days
  (+7 for expedited) if they're blank. You can edit either one by hand.
- **Shop Notes** is your own column. Customers never see it.
- **CSV:** use **ITR Orders → Email me a CSV export**, or **File → Download → Comma-separated values**.

## Changing things

| To change…                          | Edit                                    | Then                                                                           |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| Materials, colors, mods             | `web/options.js`                        | Push. Pages redeploys.                                                         |
| Form text or layout                 | `web/index.html`, `web/styles.css`      | Push.                                                                          |
| Emails, turnaround days, statuses   | `CONFIG` / `STATUSES` in `Code.gs`      | Paste into Apps Script, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy** |

Keep the copy in the Apps Script editor in sync with `apps-script/Code.gs` in the repo. **If you skip "New version",
the `/exec` URL keeps running the old code.** Updating the deployment keeps the same URL, so `config.js`
doesn't change.

Other `CONFIG` options:

- `SEND_CUSTOMER_CONFIRMATION`: turns the customer's copy on or off (default on).
- `EMAIL_CUSTOMER_ON_STATUS_CHANGE`: emails the customer whenever you change their status (default off).
- `STANDARD_TURNAROUND_DAYS` / `EXPEDITED_TURNAROUND_DAYS`: used for Est. Due Date.

## Troubleshooting

| Symptom                                          | Fix                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Form says "We couldn't reach the server"         | Check `config.js` has the `/exec` URL, not `/dev`, and that the deployment's access is **Anyone**. |
| Row saved but no emails                          | Check Apps Script → **Executions** for errors. Free Gmail can send about 100 script emails a day, and each order uses 2. |
| Intake / due dates don't fill in                 | Run `setup` again. It installs the trigger that watches the Status column.                |
| Code changes aren't taking effect                | Deploy a **New version** (see above).                                                     |
| "Authorization required" after a code change     | Run `setup` once in the editor and re-approve.                                            |
| Pages site is 404                                | Settings → Pages → Source must be **GitHub Actions**. Also check the Actions run passed.  |

## Development

```sh
npm test             # backend tests (Node 20+)
npm run serve        # form at http://localhost:8080
```

Notes:

- Spam protection is a hidden "honeypot" field that catches simple bots. If spam gets through, add
  [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/) or reCAPTCHA.
- Values that look like spreadsheet formulas are stored as plain text, and customer input is HTML-escaped in emails.
- The form posts as `text/plain` on purpose. Apps Script can't answer CORS preflight requests, and a `text/plain`
  post doesn't trigger one.
