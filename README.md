# Gifted Gifter

Private wish lists and secret gift draws for family and friends. A Prism Cortex project.
It will live at **https://giftedgifter.prismcortex.net**.

- **Lists**: members type an idea, paste a link from any store, or add a photo (choose a file, drag it in, or paste a screenshot). Each item can also have a price, how much you want it (nice / really want / ★ most wanted), how many, and notes for size, color or model. There's no product search. People add only what they choose.
- **Import**: paste a list from notes, email or another wish-list site (each line can be `Title - link`, a bare link, or just an idea), or upload a CSV with title/link/price/notes columns. You get a preview to edit before importing.
- **Groups**: anyone can start one and invite people with a link or a 6-letter code. Your one list is shared with everyone in all your groups.
- **Draw names**: the organizer sets households (spouses or housemates never draw each other), "never pair" exclusions, and an optional "no swaps" rule, then draws. Each person sees only their own match, behind a tap-to-reveal blur. People who joined after the draw get flagged so the organizer can redraw.
- **Mark as bought**: one tap, with undo. Everyone else sees "Bought by Jen" so nobody doubles up. The person the list belongs to never sees it, not even through the API. Bought items collect on your **Shopping** page, and if someone deletes something you already bought, it stays there marked "Removed from their list".
- **Live**: lists, purchases, joins and draws update for everyone right away over a WebSocket.

## Stack (same pattern as ICYN)

| Piece | What |
|---|---|
| Hosting | AWS Amplify Hosting connected to GitHub (push to `main` = deploy), no build step, custom domain |
| Sign-in | Cognito managed login, OAuth code + PKCE (`site/auth.js`, ported from ICYN's `auth.js`) |
| API | HTTP API with a Cognito JWT authorizer → Lambda `gifted-gifter-api` |
| Live | WebSocket API → the same Lambda. It verifies the ID token on `$connect` and sends "changed" pings, and browsers refetch over HTTP so the privacy rules always apply |
| Data | DynamoDB single table `gifted-gifter` (pk/sk, layout documented at the top of `backend/index.mjs`) |
| Photos | Private S3 bucket. The browser shrinks photos to max 1200px JPEG and uploads with a presigned URL (signed by hand in `backend/s3.mjs`, no extra packages) |

Everything is in `infra/template.yaml` (CloudFormation), region `us-east-1`, profile `prismcortex`.

## Deploy

**Website: push to deploy.** Amplify is connected to the GitHub repo, so every push to `main` publishes `site/` (`amplify.yml`), just like ICYN.

**Backend: `deploy.ps1`** handles Cognito, DynamoDB, S3, the APIs and the Lambda. Run it when `backend/` or `infra/` changes:

```powershell
.\deploy.ps1            # stack + Lambda code + writes site\config.js
.\deploy.ps1 -CodeOnly  # Lambda code only
```

### First-time setup

1. **Backend:** run `.\deploy.ps1`. It writes `site\config.js` with the real API and sign-in IDs. They're public IDs, not secrets, so it gets committed.
2. **Repo:** create an empty GitHub repo (e.g. `gifted-gifter`), then:
   ```powershell
   git init -b main; git add .; git commit -m "Gifted Gifter"
   git remote add origin https://github.com/<you>/gifted-gifter.git; git push -u origin main
   ```
3. **Amplify:** in the Amplify console choose **Create new app → GitHub**, pick the repo and `main`. It finds `amplify.yml` on its own. Deploy.
4. **Domain:** in the app's **Custom domains**, add `giftedgifter.prismcortex.net`. If prismcortex.net's DNS is in Route 53 in this account, Amplify sets up the records; otherwise it shows the CNAMEs to add at your DNS provider.
5. **Optional:** to also sign in on the `main.<id>.amplifyapp.com` address, run
   `.\deploy.ps1 -AmplifyOrigin https://main.<id>.amplifyapp.com` once.

Notes:
- Cognito's built-in email sender is capped at about 50 emails a day. That's fine for family groups. If it ever grows, switch the pool to SES (you already use SES for ICYN feedback).
- The table and photo bucket have `DeletionPolicy: Retain`, so deleting the stack never deletes anyone's lists.
- If `giftedgifter-prismcortex` is already taken as a Cognito domain prefix, add `AuthDomainPrefix=<another>` to the deploy command's parameter overrides.

## Run it locally (no AWS)

```powershell
node dev\server.mjs     # http://localhost:8080
```

This uses an in-memory database and a fake sign-in that asks for a name. Open a second browser profile to play a second person. Live updates are off locally, so refresh to see the other person's changes.

## API

All routes need a Cognito ID token (`Authorization: Bearer …`).

| Route | |
|---|---|
| `GET /me` · `PUT /me {name}` | profile + your groups |
| `GET /items` · `POST /items {item}` or `{items:[…]}` · `PUT/DELETE /items/{id}` | your list |
| `POST /uploads {contentType}` | presigned photo upload → `{key, uploadUrl}` |
| `GET /shopping` | what you've marked bought |
| `POST /groups` · `POST /join {code}` | create / join |
| `GET/PUT/DELETE /groups/{gid}` | group (PUT/DELETE: organizer only; PUT takes `rules {households, exclusions, noPairs}`) |
| `DELETE /groups/{gid}/members/{uid}` | leave, or the organizer removes someone |
| `POST/DELETE /groups/{gid}/draw` | draw / clear (organizer) |
| `GET /groups/{gid}/lists/{uid}` | a member's list (no bought info if it's yours) |
| `POST/DELETE /groups/{gid}/lists/{uid}/items/{id}/bought` | mark / unmark bought |
