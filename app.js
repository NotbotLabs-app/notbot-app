(() => {
  'use strict';

  /* ------------------------------------------------------------------
   * CONFIG
   * ------------------------------------------------------------------ */
  const CONFIG = {
    RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=3037fcc9-ac26-42ce-9d7e-df1cc859c183',
    FEE_WALLET: '6rmpAs64hoFht7qCAL4kXvtHvDfnv9BfjbSmBPhQXqWh',
    FEE_BPS: 1500,      // 15% service fee (basis points)
    BATCH_SIZE: 18,     // close instructions per transaction
  };

  const {
    Connection, PublicKey, Transaction, TransactionInstruction,
    SystemProgram, LAMPORTS_PER_SOL,
  } = window.solanaWeb3;

  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const FEE_WALLET = new PublicKey(CONFIG.FEE_WALLET);

  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');

  /* ------------------------------------------------------------------
   * DOM
   * ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);
  const els = {
    walletButtons: $('walletButtons'),
    connected: $('connected'),
    connectedAddr: $('connectedAddr'),
    disconnectBtn: $('disconnectBtn'),
    addressInput: $('addressInput'),
    scanBtn: $('scanBtn'),
    status: $('status'),
    results: $('results'),
    resCount: $('resCount'),
    resTotal: $('resTotal'),
    resFee: $('resFee'),
    resNet: $('resNet'),
    accountList: $('accountList'),
    closeBtn: $('closeBtn'),
    closeHint: $('closeHint'),
    txLinks: $('txLinks'),
  };

  /* ------------------------------------------------------------------
   * State
   * ------------------------------------------------------------------ */
  const state = {
    provider: null,
    walletKey: null,      // PublicKey of connected wallet
    scannedOwner: null,   // PublicKey that was scanned
    accounts: [],         // [{ pubkey, programId, mint, lamports }]
    busy: false,
  };

  /* ------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------ */
  const short = (s) => `${s.slice(0, 4)}…${s.slice(-4)}`;
  const fmtSol = (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(6) + ' SOL';
  const feeOf = (lamports) => Math.floor((lamports * CONFIG.FEE_BPS) / 10000);

  function setStatus(msg, type) {
    els.status.textContent = msg || '';
    els.status.className = 'status' + (type ? ' ' + type : '');
  }

  function setBusy(busy) {
    state.busy = busy;
    els.scanBtn.disabled = busy;
    els.closeBtn.disabled = busy || !canClose();
  }

  function canClose() {
    return !!(
      state.walletKey &&
      state.scannedOwner &&
      state.walletKey.equals(state.scannedOwner) &&
      state.accounts.length > 0
    );
  }

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

  const INSTALL_LINKS = {
    phantom: 'https://phantom.app/',
    solflare: 'https://solflare.com/',
    backpack: 'https://backpack.app/',
  };

  /* ------------------------------------------------------------------
   * Wallet connect
   * ------------------------------------------------------------------ */
  async function connectWallet(name) {
    const provider = getProvider(name);
    if (!provider) {
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (name === 'phantom' && isMobile) {
        const url = encodeURIComponent(location.href);
        const ref = encodeURIComponent(location.origin);
        window.location.href = `https://phantom.app/ul/browse/${url}?ref=${ref}`;
        return;
      }
      setStatus(`${name[0].toUpperCase() + name.slice(1)} was not found in this browser. Install it or open NOTBOT inside the wallet app's browser.`, 'error');
      window.open(INSTALL_LINKS[name], '_blank', 'noopener');
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
      els.addressInput.value = state.walletKey.toBase58();
      setStatus('Wallet connected. Scanning…');
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
    setStatus('');
    updateCloseHint();
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
    for (const { programId, value } of responses) {
      for (const { pubkey, account } of value) {
        const info = account.data?.parsed?.info;
        if (!info) continue;
        if (info.tokenAmount?.amount !== '0') continue;      // still holds tokens
        if (info.state && info.state !== 'initialized') continue; // frozen
        if (info.closeAuthority && info.closeAuthority !== owner.toBase58()) continue;
        empty.push({
          pubkey,
          programId,
          mint: info.mint,
          lamports: account.lamports,
        });
      }
    }
    return empty;
  }

  async function scan() {
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
    els.txLinks.hidden = true;
    els.txLinks.textContent = '';
    setStatus('Scanning token accounts…');

    try {
      const accounts = await fetchEmptyAccounts(owner);
      state.scannedOwner = owner;
      state.accounts = accounts;
      renderResults();

      if (accounts.length === 0) {
        setStatus('No empty token accounts found. Nothing to reclaim here.', 'ok');
      } else {
        setStatus(`Found ${accounts.length} empty account${accounts.length === 1 ? '' : 's'}.`, 'ok');
      }
    } catch (err) {
      console.error(err);
      setStatus('Could not read this wallet from the network. Wait a moment and scan again.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function renderResults() {
    const total = state.accounts.reduce((s, a) => s + a.lamports, 0);
    const fee = state.accounts.length ? computeTotalFee() : 0;
    const net = total - fee;

    els.resCount.textContent = String(state.accounts.length);
    els.resTotal.textContent = fmtSol(total);
    els.resFee.textContent = fmtSol(fee);
    els.resNet.textContent = fmtSol(net);

    els.accountList.textContent = '';
    for (const a of state.accounts) {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = short(a.mint);
      const right = document.createElement('span');
      right.textContent = (a.lamports / LAMPORTS_PER_SOL).toFixed(6);
      li.append(left, right);
      els.accountList.appendChild(li);
    }

    els.results.hidden = false;
    els.closeBtn.disabled = !canClose();
    updateCloseHint();
  }

  // Fee is computed per batch (exactly as in the transactions), then summed,
  // so the number shown here always equals what the wallet will show.
  function computeTotalFee() {
    let fee = 0;
    for (const batch of chunk(state.accounts, CONFIG.BATCH_SIZE)) {
      fee += feeOf(batch.reduce((s, a) => s + a.lamports, 0));
    }
    return fee;
  }

  function updateCloseHint() {
    if (!state.accounts.length) { els.closeHint.textContent = ''; return; }
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
  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

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

    // 1) Close every empty account; rent goes back to the owner
    for (const a of batch) {
      tx.add(closeAccountIx(a.pubkey, owner, owner, a.programId));
    }

    // 2) Send the service fee (15% of the rent released in this batch)
    const fee = feeOf(batch.reduce((s, a) => s + a.lamports, 0));
    if (fee > 0) {
      tx.add(SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: FEE_WALLET,
        lamports: fee,
      }));
    }
    return tx;
  }

  async function reclaim() {
    if (!canClose() || state.busy) return;

    const owner = state.walletKey;
    const provider = state.provider;
    setBusy(true);
    els.txLinks.hidden = true;
    els.txLinks.textContent = '';

    try {
      setStatus('Preparing transactions…');
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const batches = chunk(state.accounts, CONFIG.BATCH_SIZE);
      const txs = batches.map((b) => buildTransaction(b, owner, blockhash));

      setStatus(`Approve ${txs.length} transaction${txs.length === 1 ? '' : 's'} in your wallet…`);
      let signed;
      if (typeof provider.signAllTransactions === 'function') {
        signed = await provider.signAllTransactions(txs);
      } else {
        signed = [];
        for (const tx of txs) signed.push(await provider.signTransaction(tx));
      }

      const signatures = [];
      for (let i = 0; i < signed.length; i++) {
        setStatus(`Sending transaction ${i + 1} of ${signed.length}…`);
        const sig = await connection.sendRawTransaction(signed[i].serialize());
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
        signatures.push(sig);
        addTxLink(sig, i + 1);
      }

      setStatus(`Done. ${state.accounts.length} account${state.accounts.length === 1 ? '' : 's'} closed and SOL returned to your wallet.`, 'ok');
      await scan();
      els.txLinks.hidden = false;
    } catch (err) {
      console.error(err);
      const msg = String(err?.message || err);
      if (/reject|denied|cancel/i.test(msg)) {
        setStatus('You rejected the request. Nothing was sent.', 'error');
      } else if (/insufficient|0x1\b|debit/i.test(msg)) {
        setStatus('Not enough SOL to pay the network fee. Add a little SOL (about 0.00005) and try again.', 'error');
      } else {
        setStatus('The transaction failed. Scan again and retry. If it repeats, close fewer accounts by trying later.', 'error');
      }
    } finally {
      setBusy(false);
    }
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

  /* ------------------------------------------------------------------
   * Events
   * ------------------------------------------------------------------ */
  els.walletButtons.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-wallet]');
    if (btn) connectWallet(btn.dataset.wallet);
  });
  els.disconnectBtn.addEventListener('click', disconnectWallet);
  els.scanBtn.addEventListener('click', scan);
  els.addressInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') scan(); });
  els.closeBtn.addEventListener('click', reclaim);
})();
