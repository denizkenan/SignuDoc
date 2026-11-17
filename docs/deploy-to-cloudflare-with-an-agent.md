# Deploying SignuDoc to Cloudflare with an agent

This page is for an AI agent that controls a web browser and has been asked to deploy SignuDoc to Cloudflare for someone. It lists every step, what to choose, what to ask the person, and what to do when a step fails. A person can follow it too. [SignuDoc on Cloudflare](../cloudflare/README.md) explains the setup in more depth.

The person you are working for is called "the person" below.

## Before you start

- The browser should already be signed in to the person's **Cloudflare** account and to the **GitHub** account Cloudflare will copy SignuDoc into. If a sign-in page or a security check appears, stop and ask the person to complete it. Never type a password, a one-time code or a passkey prompt for them unless they give you that job.
- The Cloudflare account must be on the **Workers Paid** plan. Containers and Email Sending are not on the free plan. If a screen asks to upgrade, add a card or start a trial, stop and ask the person.
- SignuDoc needs a **Postgres database**, and Cloudflare has none to create. Ask the person where it should come from. [Neon](https://neon.com)'s free plan is enough. If they want you to create it, the browser must be signed in to that provider too.
- Ask the person for these before you begin, so you are not stopped half way:
  1. **The domain email should come from**, which must be a domain on their Cloudflare account, for example `acme.com`. A `sign.` subdomain (`sign.acme.com`) keeps this site's email apart from the organization's own. If they have none yet, email can wait.
  2. **The organization's name**, as signers should see it.
  3. **The support email address** signers and staff should write to for help.
  4. **The administrator's name and email address.** The person creates the password themselves at step 6, or tells you to use their password manager.
- Do one step at a time, and check each result on the page before you move on. Cloudflare changes its wording from time to time, so match screens by what they do, not by exact text.

## 1. Get the database's connection string

In the database provider, create a project (on Neon, the free plan and the region closest to the person) and find its Postgres connection string. Turn **connection pooling off** first: SignuDoc's database setup needs a direct connection. The string starts with `postgresql://`.

Keep it on the clipboard for step 3. It contains the database password, so never put it in a chat, a file or a message.

## 2. Open the Deploy button

Open this address (it is the "Deploy to Cloudflare" button in the [README](../README.md)):

```
https://deploy.workers.cloudflare.com/?url=https://github.com/denizkenan/SignuDoc
```

## 3. Fill in the one screen

Cloudflare shows a single setup screen. On it:

1. **Git account and repository.** Choose the person's GitHub account (or the organization they name) and keep the name `signudoc` unless it is taken. A private repository is fine. If Cloudflare asks to install or authorize its GitHub app, that is expected; if GitHub asks the person to confirm with a passkey or code, hand over to them.
2. **Project name.** Keep `signudoc`. It becomes part of the site's first address.
3. **R2 bucket.** Keep the name offered, or choose another if it is taken. It is where documents are kept.
4. **`DATABASE_URL`.** Paste the connection string from step 1.
5. **Build command.** Leave it empty, and clear it if Cloudflare filled one in. The app is built inside its container image during the deploy.
6. **Deploy command.** `npx wrangler deploy`.

If the screen asks for any other value, leave it empty. SignuDoc works the rest out itself.

## 4. Deploy

Start the deployment and wait. The first one builds a container image and usually takes five to ten minutes.

- **Success.** Cloudflare shows the new Worker with its address, `https://signudoc.<subdomain>.workers.dev`. Go to step 5.
- **A message about Containers, a plan or billing.** The account is not on Workers Paid. Stop and tell the person.
- **The build fails with a log.** Do not redeploy in a loop. Copy the last 30 or so lines of the build log and give them to the person.

## 5. Open the new site

Open the Worker's address. Do this straight away: a new install belongs to whoever sets it up first.

- **An error, or nothing for a minute.** Cloudflare is still preparing the container after a first deployment. Wait two minutes and reload. Try up to five times before you report it.
- **It opens on `/setup`.** Go to step 6.
- **It says to connect a database.** `DATABASE_URL` did not reach the Worker. In the Worker's **Settings**, under **Variables and Secrets**, add a secret named `DATABASE_URL` with the connection string and save. The app restarts by itself within a minute or two. Reload the site.

## 6. Set the site up

On the setup page:

1. Enter the **organization's name** and the **support email address**.
2. Under **Send email from**, clear **Your domain**. The setup page fills it from the site's own address, which cannot send email. The sender address is set at step 7.
3. Enter the **administrator's name** and **email**. Let the person type the password, or use their password manager if they told you to. Never make one up and keep it.
4. Finish setup. You are signed in as the administrator.

## 7. Turn on email

Skip this step if the person has no sending domain yet, and say so in your report.

1. In the Cloudflare dashboard, turn on **Email Sending** for the domain or subdomain the person gave you. Cloudflare adds the DNS records itself when the domain is on the same account.
2. In SignuDoc, open **Settings, Organization**. Enter an address at that domain in **Send email from**, such as `documents@sign.acme.com`, and save.
3. Under **Email setup**, send a test email. Then:
   - **"Email is working".** Email is ready. Ask the person to check that the message arrived, and to look in spam.
   - **A message that the sending domain could not be found.** Email Sending is not on for the domain in the address. Check step 7.1 and the spelling of the address.

Some labels on these pages still say "Resend". This copy sends through Cloudflare.

## 8. Report back

Tell the person:

- the site's address and the GitHub repository it deploys from,
- whether the test email was sent, and from which address,
- anything you could not do, and why.

Then point them to [SignuDoc on Cloudflare](../cloudflare/README.md) for their own web address, `SETUP_TOKEN`, and keeping the install up to date.

## Rules for the agent

- Never pay for, upgrade or start a trial of anything without the person's say-so.
- Never delete a Worker, bucket, database or repository to "start over". If something is badly wrong, stop and ask.
- Never copy a secret (API tokens, database URLs, passwords) into a chat, a file or a message.
- Do not complete a security check or CAPTCHA for the person. Hand over to them.
- Redeploy only when a step above says to, and no more than three times in a row.
