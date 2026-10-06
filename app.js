(() => {
  'use strict';

  /* ------------------------------------------------------------------
   * CONFIG
   * ------------------------------------------------------------------ */
  const CONFIG = {
    RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=3037fcc9-ac26-42ce-9d7e-df1cc859c183',
    FEE_WALLET: '7mR69k8GwjKcKgCRwsKUaMvrqFjvHK2roXi3UF8TWBLA',
    FEE_BPS: 100,         // 1% service fee (basis points)
    BATCH_SIZE: 8,        // close instructions per transaction
    MAX_PER_ROUND: 24,    // accounts handled per "Reclaim" press
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    walletButtons: $('walletButtons'),
    openInWallet: $('openInWallet'),
    connected: $('connected'),
    connectedAddr: $('connectedAddr'),
    disconnectBtn: $('disconnectBtn'),
    addressInput: $('addressInput'),
    scanBtn: $('scanBtn'),
    status: $('status'),
    results: $('results'),
    resFound: $('resFound'),
    resRound: $('resRound'),
    resTotal: $('resTotal'),
    resFee: $('resFee'),
    resNet: $('resNet'),
    moreNote: $('moreNote'),
    accountList: $('accountList'),
    closeBtn: $('closeBtn'),
    closeHint: $('closeHint'),
    txLinks: $('txLinks'),
  };

  function setStatus(msg, type) {
    els.status.textContent = msg || '';
    els.status.className = 'status' + (type ? ' ' + type : '');
  }

  if (!window.solanaWeb3) {
    setStatus('Could not load the Solana library. Check your connection and reload the page.', 'error');
    return;
  }

  const {
    Connection, PublicKey, Transaction, TransactionInstruction,
    SystemProgram, LAMPORTS_PER_SOL,
  } = window.solanaWeb3;

  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const FEE_WALLET = new PublicKey(CONFIG.FEE_WALLET);
  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');

  // The official address. Used for "Copy link" and wallet deep links.
  const SITE_URL = 'https://www.notbotapp.xyz/';
  const SITE_ORIGIN = new URL(SITE_URL).origin;
  const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  /* ------------------------------------------------------------------
   * State
   * ------------------------------------------------------------------ */
  const state = {
    provider: null,
    walletKey: null,      // PublicKey of the connected wallet
    scannedOwner: null,   // PublicKey that was scanned
    accounts: [],         // every empty account found
    round: [],            // the slice that will be closed now
    busy: false,
  };

  /* ------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------ */
  const short = (s) => `${s.slice(0, 4)}…${s.slice(-4)}`;
  const fmtSol = (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(6) + ' SOL';
  const feeOf = (lamports) => Math.floor((lamports * CONFIG.FEE_BPS) / 10000);
  const sumLamports = (list) => list.reduce((s, a) => s + a.lamports, 0);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function setBusy(busy) {
    state.busy = busy;
    els.scanBtn.disabled = busy;
    els.closeBtn.disabled = busy || !canClose();
  }

  function canClose() {
    return !!(
      state.walletKey && state.scannedOwner &&
      state.walletKey.equals(state.scannedOwner) &&
      state.round.length > 0
    );
  }

  /* ------------------------------------------------------------------
   * Wallet detection and "open in wallet" helpers
   * ------------------------------------------------------------------ */
  function getProvider(name) {
    switch (name) {
      case 'phantom':
        return window.phantom?.solana?.isPhantom
          ? window.phantom.solana
          : (window.solana?.isPhantom ? window.solana : null);
      case 'solflare':
        return window.solflare?.isSolflare ? window.solflare : null;
      case 'backpack':
        return window.backpack?.solana || window.backpack || null;
      default:
        return null;
    }
  }

  const anyWalletPresent = () =>
    ['phantom', 'solflare', 'backpack'].some((n) => getProvider(n));

  const INSTALL_LINKS = {
    phantom: 'https://phantom.app/',
    solflare: 'https://solflare.com/',
    backpack: 'https://backpack.app/',
  };

  function deepLink(name) {
    const url = encodeURIComponent(SITE_URL);
    const ref = encodeURIComponent(SITE_ORIGIN);
    if (name === 'phantom') return `https://phantom.app/ul/browse/${url}?ref=${ref}`;
    if (name === 'solflare') return `https://solflare.com/ul/v1/browse/${url}?ref=${ref}`;
    return null;
  }

  function openInWallet(name) {
    const link = deepLink(name);
    if (link) {
      window.location.href = link;
    } else {
      copyLink();
      setStatus(`Link copied. Open the ${cap(name)} app, go to its Browser, paste the link and press Go.`, 'ok');
    }
  }

  async function copyLink(btn) {
    try {
      await navigator.clipboard.writeText(SITE_URL);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = SITE_URL;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (__) { /* ignore */ }
      ta.remove();
    }
    if (btn) {
      const old = btn.textContent;
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.textContent = old; }, 2000);
    }
  }

  // Wallets inject their provider a moment after load, so check late.
  function maybeShowOpenInWallet() {
    els.openInWallet.hidden = anyWalletPresent();
  }
  setTimeout(maybeShowOpenInWallet, 1200);

  /* ------------------------------------------------------------------
   * Wallet connect
   * ------------------------------------------------------------------ */
  async function connectWallet(name) {
    const provider = getProvider(name);

    if (!provider) {
      if (IS_MOBILE && deepLink(name)) {
        window.location.href = deepLink(name);
        return;
      }
      els.openInWallet.hidden = false;
      if (IS_MOBILE) {
        setStatus(`${cap(name)} was not found here. Tap "Copy link", open the ${cap(name)} app's Browser and paste it.`, 'error');
      } else {
        setStatus(`${cap(name)} was not found in this browser. Install its extension, then reload this page.`, 'error');
        window.open(INSTALL_LINKS[name], '_blank', 'noopener');
      }
      return;
    }

    try {
      setStatus('Waiting for your wallet…');
      await provider.connect();
      const pk = provider.publicKey;
      if (!pk) throw new Error('No public key returned');

      state.provider = provider;
      state.walletKey = new PublicKey(pk.toString());

      els.connectedAddr.textContent = short(state.walletKey.toBase58());
      els.connected.hidden = false;
      els.walletButtons.hidden = true;
      els.openInWallet.hidden = true;
      els.addressInput.value = state.walletKey.toBase58();
      await scan();
    } catch (err) {
      console.error(err);
      setStatus('Connection was cancelled or failed. Try again.', 'error');
    }
  }

  async function disconnectWallet() {
    try { await state.provider?.disconnect?.(); } catch (_) { /* ignore */ }
    state.provider = null;
    state.walletKey = null;
    els.connected.hidden = true;
    els.walletButtons.hidden = false;
    els.closeBtn.disabled = true;
    updateCloseHint();
    setStatus('');
  }

  /* ------------------------------------------------------------------
   * Scan for empty token accounts
   * ------------------------------------------------------------------ */
  async function fetchEmptyAccounts(owner) {
    const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
    const responses = await Promise.all(
      programs.map((programId) =>
        connection.getParsedTokenAccountsByOwner(owner, { programId })
          .then((r) => ({ programId, value: r.value }))
      )
    );

    const empty = [];
    let total = 0;
    let skipped = 0;

    for (const { programId, value } of responses) {
      for (const { pubkey, account } of value) {
        total++;
        const info = account.data?.parsed?.info;
        if (!info) continue;
        if (info.tokenAmount?.amount !== '0') continue;                 // still holds tokens
        if (info.state && info.state !== 'initialized') { skipped++; continue; } // frozen
        if (info.closeAuthority && info.closeAuthority !== owner.toBase58()) { skipped++; continue; }
        empty.push({ pubkey, programId, mint: info.mint, lamports: account.lamports });
      }
    }

    console.log('[NOTBOT] scanned', total, 'token accounts,', empty.length, 'empty,', skipped, 'skipped');
    return { empty, total, skipped };
  }

  async function scan({ keepStatus = false } = {}) {
    const raw = els.addressInput.value.trim();
    if (!raw) {
      setStatus('Paste a wallet address or connect a wallet first.', 'error');
      return;
    }

    let owner;
    try {
      owner = new PublicKey(raw);
    } catch (_) {
      setStatus('That is not a valid Solana address. Check it and try again.', 'error');
      return;
    }

    setBusy(true);
    if (!keepStatus) {
      els.txLinks.hidden = true;
      els.txLinks.textContent = '';
      setStatus('Scanning token accounts…');
    }

    try {
      const { empty, total, skipped } = await fetchEmptyAccounts(owner);
      state.scannedOwner = owner;
      state.accounts = empty;
      state.round = empty.slice(0, CONFIG.MAX_PER_ROUND);
      renderResults();

      if (!keepStatus) {
        const note = skipped ? ` (${skipped} skipped: frozen or locked)` : '';
        const plural = total === 1 ? '' : 's';
        if (empty.length === 0) {
          setStatus(`Scanned ${total} token account${plural}: none are empty, nothing to reclaim.${note}`, 'ok');
        } else {
          setStatus(`Scanned ${total} token account${plural}: ${empty.length} empty.${note}`, 'ok');
        }
      }
    } catch (err) {
      console.error(err);
      setStatus('Could not read this wallet from the network. Wait a moment and scan again.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function totalFee(list) {
    let fee = 0;
    for (const batch of chunk(list, CONFIG.BATCH_SIZE)) fee += feeOf(sumLamports(batch));
    return fee;
  }

  function renderResults() {
    const total = sumLamports(state.round);
    const fee = totalFee(state.round);

    els.resFound.textContent = String(state.accounts.length);
    els.resRound.textContent = String(state.round.length);
    els.resTotal.textContent = fmtSol(total);
    els.resFee.textContent = fmtSol(fee);
    els.resNet.textContent = fmtSol(total - fee);

    const remaining = state.accounts.length - state.round.length;
    if (remaining > 0) {
      els.moreNote.textContent = `${remaining} more account${remaining === 1 ? '' : 's'} will remain. Press Reclaim again after this round.`;
      els.moreNote.hidden = false;
    } else {
      els.moreNote.hidden = true;
    }

    els.accountList.textContent = '';
    for (const a of state.round) {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = short(a.mint);
      const right = document.createElement('span');
      right.textContent = (a.lamports / LAMPORTS_PER_SOL).toFixed(6);
      li.append(left, right);
      els.accountList.appendChild(li);
    }

    els.results.hidden = false;
    els.closeBtn.disabled = state.busy || !canClose();
    updateCloseHint();
  }

  function updateCloseHint() {
    if (!state.round.length) { els.closeHint.textContent = ''; return; }
    if (!state.walletKey) {
      els.closeHint.textContent = 'Connect the wallet that owns these accounts to reclaim.';
    } else if (!state.walletKey.equals(state.scannedOwner)) {
      els.closeHint.textContent = 'The connected wallet is different from the scanned address. Scan your own wallet to reclaim.';
    } else {
      els.closeHint.textContent = 'Your wallet will show every instruction before you approve.';
    }
  }

  /* ------------------------------------------------------------------
   * Build and send transactions
   * ------------------------------------------------------------------ */

  // SPL Token / Token-2022 "CloseAccount" instruction (index 9)
  function closeAccountIx(account, destination, owner, programId) {
    return new TransactionInstruction({
      programId,
      keys: [
        { pubkey: account, isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data: Uint8Array.of(9),
    });
  }

  function buildTransaction(batch, owner, blockhash) {
    const tx = new Transaction();
    tx.feePayer = owner;
    tx.recentBlockhash = blockhash;

    // 1) Close every empty account; the rent goes back to the owner
    for (const a of batch) tx.add(closeAccountIx(a.pubkey, owner, owner, a.programId));

    // 2) Service fee: 1% of the rent released in this batch
    const fee = feeOf(sumLamports(batch));
    if (fee > 0) {
      tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: FEE_WALLET, lamports: fee }));
    }
    return tx;
  }

  function addTxLink(sig, n) {
    const a = document.createElement('a');
    a.href = `https://solscan.io/tx/${sig}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `Transaction ${n}: ${short(sig)}`;
    els.txLinks.appendChild(a);
    els.txLinks.hidden = false;
  }

  async function reclaim() {
    if (!canClose() || state.busy) return;

    const owner = state.walletKey;
    const provider = state.provider;
    const closing = state.round.length;
    setBusy(true);
    els.txLinks.hidden = true;
    els.txLinks.textContent = '';

    try {
      setStatus('Preparing transactions…');
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const batches = chunk(state.round, CONFIG.BATCH_SIZE);
      const txs = batches.map((b) => buildTransaction(b, owner, blockhash));

      setStatus(`Approve ${txs.length} transaction${txs.length === 1 ? '' : 's'} in your wallet…`);
      let signed;
      if (typeof provider.signAllTransactions === 'function') {
        signed = await provider.signAllTransactions(txs);
      } else {
        signed = [];
        for (const tx of txs) signed.push(await provider.signTransaction(tx));
      }

      for (let i = 0; i < signed.length; i++) {
        setStatus(`Sending transaction ${i + 1} of ${signed.length}…`);
        const sig = await connection.sendRawTransaction(signed[i].serialize());
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
        addTxLink(sig, i + 1);
      }

      await scan({ keepStatus: true });
      const left = state.accounts.length;
      let msg = `Done. ${closing} account${closing === 1 ? '' : 's'} closed and SOL returned to your wallet.`;
      if (left > 0) msg += ` ${left} empty account${left === 1 ? '' : 's'} still remain: press Reclaim for the next round.`;
      setStatus(msg, 'ok');
    } catch (err) {
      console.error(err);
      const msg = String(err?.message || err);
      if (/reject|denied|cancel/i.test(msg)) {
        setStatus('You rejected the request. Nothing was sent.', 'error');
      } else if (/insufficient|0x1\b|debit/i.test(msg)) {
        setStatus('Not enough SOL to pay the network fee. Add a little SOL (about 0.00005) and try again.', 'error');
      } else {
        const detail = msg.replace(/\s+/g, ' ').slice(0, 160);
        setStatus(`The transaction failed: ${detail}`, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------------------
   * Events
   * ------------------------------------------------------------------ */
  document.addEventListener('click', (e) => {
    const walletBtn = e.target.closest('[data-wallet]');
    if (walletBtn) { connectWallet(walletBtn.dataset.wallet); return; }

    const openBtn = e.target.closest('[data-open]');
    if (openBtn) { openInWallet(openBtn.dataset.open); return; }

    const copyBtn = e.target.closest('.js-copy-link');
    if (copyBtn) { copyLink(copyBtn); }
  });

  els.disconnectBtn.addEventListener('click', disconnectWallet);
  els.scanBtn.addEventListener('click', () => scan());
  els.addressInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') scan(); });
  els.closeBtn.addEventListener('click', reclaim);
})();
