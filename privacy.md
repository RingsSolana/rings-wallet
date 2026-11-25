---
title: Rings Wallet privacy policy
permalink: /privacy/
---

# Rings Wallet privacy policy
Last updated: 24 November 2026

Rings Wallet is a Solana wallet, as a browser extension and as an Android app, made by Rings (rings.run). This policy
says what the wallet does with your data, who receives it, and why. Where the extension and the app differ, it says so.

### What stays on your device

- Your recovery phrase and private keys. They are kept encrypted with your password, and they never leave your device.
  Your password is never stored or sent.
- The list of sites and apps you connected, inside the same encrypted vault.
- Your settings, your Activity list (what you sent, received and swapped, with addresses and amounts) and the swaps
  still under way.
  - In the extension, they are kept in the extension's own storage, which websites can't read. They aren't encrypted:
    anyone who can open your browser profile on your computer could read them.
  - In the Android app, everything the wallet keeps is also encrypted with a key held by your phone's secure hardware
    (Android Keystore), in storage only the app can read.
- In the Android app, the Mobile Wallet Adapter library also keeps, in the app's own storage and not encrypted, the
  apps you approved (their names and addresses) and the address you gave each.
- In the Android app, the list of accessibility apps that are on, which the app reads to warn you, stays on your phone.
  A recovery phrase or key you copy is cleared from the clipboard after a minute.

Removing the extension, or uninstalling the app, removes all of this from your device.

### What is sent, to whom, and why

The wallet sends only what each feature needs.

- **Rings (rings.run)**, the wallet's own service, run by the makers of Rings Wallet:
  - your addresses, to show your balances and Activity, and the transactions you approve, to preview and send them
    (through Rings' connection to the Solana network, provided by Helius);
  - what your private balance needs: its indexer lookups and its proofs (see Helius below);
  - the coins you hold privately, to show their names, pictures and prices;
  - your swaps: the coins, the amount and where the coins go, so Rings' relay can make them; and your sign-in to Rings,
    so you can use them;
  - the wallet's fee (see "Fees" below).
- **Helius**, through Rings: Solana network requests (balances, transactions, previews), the private balance's indexer,
  and its prover. A private transaction's proof inputs (the amounts spent and the key that marks them spent) are
  encrypted so that only Helius' attested prover can read them. The prover's published policy is downloaded from
  d3gbdb0egjwcw9.cloudfront.net.
- **Jupiter (lite-api.jup.ag)**, directly from your device: the coins of your public balance (for their prices), your
  token searches, the coin pair and amount of a swap you are quoting, and the address of a coin whose decimals the
  wallet checks before moving it, including coins you hold privately.
- **The Solana network**: everything you send is public on it, as on any blockchain. Moving coins into or out of your
  private balance shows the coin, the amount and your wallet. Private transfers hide their amounts, but they carry
  your Rings account key, which your deposits tie to your wallet.
- **Websites and apps you connect to**: the address you chose for that site or app (your main address, or a fresh one
  for it alone) and the signatures you approve. On a phone, apps connect through Mobile Wallet Adapter and state their
  own name, which the wallet can't confirm. The Rings sites (rings.run and its subdomains), once connected, also get
  your Rings key: in the extension while the wallet is unlocked, in the Android app each time you approve it. With it
  they show and spend your private balance. They keep it in your browser for up to seven days, as they do for every
  wallet.

Every service you reach sees your device's IP address, as any website does.

### Fees

- Rings Wallet charges a fee of 0.1% on every send, every swap and every move between your Public and Private
  balances. It is paid on top of the amount, in the same coin, to Rings, inside the same transaction. The review
  screen shows it, with the network fee, before you confirm.
- On a private action the fee is a private payment that only Rings can read. Because it is 0.1% of the amount, it
  tells Rings that action's approximate amount. Nobody else can read it.
- On a public send it goes to Rings' public address, and is visible on the chain like the send itself.
- A swap's fee is not returned if the swap is refunded.
- Transactions that websites ask the wallet to sign carry no fee from Rings Wallet.
- Network fees are separate. Private actions' network fees are paid by your Rings account key, which the wallet tops up
  from your Public balance when it runs low. That top-up is a public transfer between your wallet and that key.

Rings Wallet has no analytics, no tracking and no advertising. Your data is not sold, and it is not used for anything
but the features above. The extension's use of information complies with the Chrome Web Store User Data Policy,
including the Limited Use requirements.

### What Rings keeps on its servers

- Your wallet address, your public Rings keys and the sign-in you signed, to sign you in.
- Swaps while they are under way. Once a swap is done or refunded, who asked and where the coins went are wiped.
- Payments to the swap relay (their transaction signatures), so one payment can't be used twice.
- Screenings of wallets against the US sanctions list: only wallets found on the list are recorded.
- Server logs: the web server's request logs, with no IP address (time, site, page and status), kept 14 days, and
  the Rings app's error logs, which can include wallet addresses. Your IP address is only held in memory for a few
  minutes, to stop abuse, and never stored.

### Your choices

- You can disconnect a site or app in Settings > Connected sites.
- You can lock the wallet at any time; it also locks itself after the time you choose.
- You can remove the extension or uninstall the app. To have Rings delete the sign-in record of your wallet, write to
  us.

### Contact

ringssol@proton.me

Changes to this policy are published on this page, with the date above.
