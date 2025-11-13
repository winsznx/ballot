import axios from 'axios'
import { createObjectCsvWriter } from 'csv-writer'

// Hiro API key
const API_KEY = ''

// Hiro API URL
const BASE_URL = 'https://api.hiro.so'

// Mempool API URL
const MEMPOOL_API = 'https://mempool.space/api'

// Stacks addresses
const YES_ADDR = ''
const NO_ADDR = ''

// Bitcoin addresses
const BTC_YES_ADDR = ''
const BTC_NO_ADDR = ''

// PoX cycles
const POX_CYCLES = []

// Poll start and end block heights on the Stacks blockchain
const START_STX_BLOCK = 0
const END_STX_BLOCK = 0

// Page limit
const PAGE_LIMIT = 50

// Retry limit
const RETRY_LIMIT = 18

// Retry delay in milliseconds
const RETRY_DELAY_MS = 10_000

// Sleep function
const sleep = ms => new Promise(res => setTimeout(res, ms))

const fetchWithRetry = async (url, retries = RETRY_LIMIT) => {
  try {
    const { data } = await axios.get(url, { headers: { 'X-API-KEY': API_KEY } })
    return data
  } catch (err) {
    if (retries > 0) {
      await sleep(RETRY_DELAY_MS)
      return fetchWithRetry(url, retries - 1)
    }
    throw err
  }
}

const getRawVotes = async voteAddr => {
  let offset = 0, total = Infinity
  const events = []
  while (offset < total) {
    const url = `${BASE_URL}/extended/v2/addresses/${voteAddr}/transactions?limit=${PAGE_LIMIT}&offset=${offset}`
    const { total: t, results } = await fetchWithRetry(url)
    total = t
    for (const { tx } of results) {
      if (
        tx.tx_status === 'success' &&
        tx.tx_type === 'token_transfer' &&
        tx.token_transfer.recipient_address === voteAddr
      ) {
        events.push({
          address: tx.sender_address,
          voteAddr,
          blockHeight: tx.block_height,
          nonce: tx.tx_nonce,
        })
      }
    }
    offset += PAGE_LIMIT
    console.log(`  Fetched ${Math.min(offset, total)}/${total} STX tx for ${voteAddr}`)
  }
  return events
}

const getStxInfo = async address => {
  const url = `${BASE_URL}/extended/v1/address/${address}/stx?until_block=${START_STX_BLOCK}`
  const { locked, balance } = await fetchWithRetry(url)
  const lockedNum = Number(locked)
  const balanceNum = Number(balance)
  return {
    address,
    locked: lockedNum > 0 ? lockedNum / 1e6 : 0,
    unlocked: balanceNum > 0 && balanceNum >= lockedNum ? (balanceNum - lockedNum) / 1e6 : 0,
    total: balanceNum > 0 ? balanceNum / 1e6 : 0,
  }
}

const buildBtcToStacksMap = async () => {
  const map = new Map()
  for (const cycle of POX_CYCLES) {
    let signerOffset = 0, signerTotal = Infinity
    while (signerOffset < signerTotal) {
      const url = `${BASE_URL}/extended/v2/pox/cycles/${cycle}/signers?limit=${PAGE_LIMIT}&offset=${signerOffset}`
      const { total, results: signers } = await fetchWithRetry(url)
      signerTotal = total
      signerOffset += PAGE_LIMIT
      for (const { signing_key } of signers) {
        let stackerOffset = 0, stackerTotal = Infinity
        while (stackerOffset < stackerTotal) {
          const sUrl = `${BASE_URL}/extended/v2/pox/cycles/${cycle}/signers/${signing_key}/stackers?limit=${PAGE_LIMIT}&offset=${stackerOffset}`
          const { total: sTotal, results: stackers } = await fetchWithRetry(sUrl)
          stackerTotal = sTotal
          stackerOffset += PAGE_LIMIT
          for (const { pox_address, stacker_address } of stackers) {
            if (!map.has(pox_address)) {
              map.set(pox_address, []);
            }
            map.get(pox_address).push(stacker_address);
          }
        }
      }
    }
  }
  return map
}

const getBitcoinRawVotes = async voteAddr => {
  const events = [];

  const url = `${MEMPOOL_API}/address/${voteAddr}/txs?limit=${PAGE_LIMIT}`
  const txs = await axios.get(url).then(res => res.data)

  for (const tx of txs) {
    if (!tx.status.confirmed) continue
    tx.vin.forEach(vin => {
      events.push({ address: vin.prevout.scriptpubkey_address })
    });
  };
  console.log(`  Fetched ${txs.length} BTC tx for ${voteAddr}`)

  return events
}

const writeCsv = async (filename, records) => {
  const csvWriter = createObjectCsvWriter({
    path: filename,
    header: [
      { id: 'address', title: 'address' },
      { id: 'locked', title: 'locked' },
      { id: 'unlocked', title: 'unlocked' },
      { id: 'total', title: 'total' },
    ]
  })
  await csvWriter.writeRecords(records)
  console.log(`  Wrote ${records.length.toLocaleString('en-US')} rows to ${filename}`)
}

const fmtAmt = num => num.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 })
const fmtPct = num => num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%'

const main = async () => {
  console.log('=== Gathering raw vote events (STX-only) ===')
  const [yesEvents, noEvents] = await Promise.all([
    getRawVotes(YES_ADDR),
    getRawVotes(NO_ADDR),
  ])
  const allEvents = yesEvents.concat(noEvents)
  const firstVotes = new Map()
  allEvents.forEach(evt => {
    const prev = firstVotes.get(evt.address)
    if (
      evt.blockHeight >= START_STX_BLOCK &&
      evt.blockHeight <= END_STX_BLOCK &&
      (!prev ||
        evt.blockHeight < prev.blockHeight ||
        (evt.blockHeight === prev.blockHeight && evt.nonce < prev.nonce))
    ) {
      firstVotes.set(evt.address, evt)
    }
  })
  const stxYesAddrs = []
  const stxNoAddrs = []
  for (const { address, voteAddr } of firstVotes.values()) {
    if (voteAddr === YES_ADDR) stxYesAddrs.push(address)
    else stxNoAddrs .push(address)
  }
  console.log(`  First-vote STX YES count: ${stxYesAddrs.length.toLocaleString('en-US')}`)
  console.log(`  First-vote STX NO  count: ${stxNoAddrs.length.toLocaleString('en-US')}`)

  console.log('\n=== STX-only votes summary ===')
  const stxYesInfosRaw = await Promise.all(stxYesAddrs.map(addr => getStxInfo(addr)))
  const stxYesInfos = stxYesInfosRaw.filter(info => info.total > 0)
  const stxYesCount = stxYesInfos.length
  const stxYesStacked = stxYesInfos.reduce((sum, i) => sum + i.locked, 0)
  const stxYesUnstacked = stxYesInfos.reduce((sum, i) => sum + i.unlocked, 0)
  const stxYesTotal = stxYesInfos.reduce((sum, i) => sum + i.total, 0)
  console.log(`  STX-only YES count:         ${stxYesCount}`)
  console.log(`  STX-only YES stacked STX:   ${fmtAmt(stxYesStacked)}`)
  console.log(`  STX-only YES unstacked STX: ${fmtAmt(stxYesUnstacked)}`)
  console.log(`  STX-only YES total STX:     ${fmtAmt(stxYesTotal)}`)

  const stxNoInfosRaw = await Promise.all(stxNoAddrs.map(addr => getStxInfo(addr)))
  const stxNoInfos = stxNoInfosRaw.filter(info => info.total > 0)
  const stxNoCount = stxNoInfos.length
  const stxNoStacked = stxNoInfos.reduce((sum, i) => sum + i.locked, 0)
  const stxNoUnstacked = stxNoInfos.reduce((sum, i) => sum + i.unlocked, 0)
  const stxNoTotal = stxNoInfos.reduce((sum, i) => sum + i.total, 0)
  console.log(`  STX-only NO  count:         ${stxNoCount}`)
  console.log(`  STX-only NO  stacked STX:   ${fmtAmt(stxNoStacked)}`)
  console.log(`  STX-only NO  unstacked STX: ${fmtAmt(stxNoUnstacked)}`)
  console.log(`  STX-only NO  total STX:     ${fmtAmt(stxNoTotal)}`)

  console.log('\n=== Gathering raw vote events (BTC-only) ===')
  const [btcYesEvents, btcNoEvents] = await Promise.all([
    getBitcoinRawVotes(BTC_YES_ADDR),
    getBitcoinRawVotes(BTC_NO_ADDR),
  ])
  const btcToStacks = await buildBtcToStacksMap()
  const validBtcYes = btcYesEvents.flatMap(evt => btcToStacks.get(evt.address) || [])
  const validBtcNo = btcNoEvents.flatMap(evt => btcToStacks.get(evt.address) || [])
  console.log(`  Valid BTC YES stackers raw: ${btcYesEvents.length}`)
  console.log(`  Valid BTC NO  stackers raw: ${btcNoEvents.length}`)

  const uniqueBtcYes = [...new Set(validBtcYes)]
  const uniqueBtcNo = [...new Set(validBtcNo)]

  console.log('\n=== BTC-only votes summary ===')
  const btcYesInfos = await Promise.all(uniqueBtcYes.map(addr => getStxInfo(addr)))
  const btcYesAddrsWithData = btcYesEvents
    .filter(evt => (btcToStacks.get(evt.address) || []).length > 0)
    .map(evt => evt.address)
  const uniqueBtcYesAddrs = [...new Set(btcYesAddrsWithData)]
  const btcYesCount = uniqueBtcYesAddrs.length
  const btcYesStacked = btcYesInfos.reduce((sum, i) => sum + i.locked, 0)
  const btcYesUnstacked = 0
  const btcYesTotal = btcYesInfos.reduce((sum, i) => sum + i.locked, 0)
  console.log(`  BTC-only YES count:         ${btcYesCount}`)
  console.log(`  BTC-only YES stacked STX:   ${fmtAmt(btcYesStacked)}`)
  console.log(`  BTC-only YES unstacked STX: ${fmtAmt(btcYesUnstacked)}`)
  console.log(`  BTC-only YES total STX:     ${fmtAmt(btcYesTotal)}`)

  const btcNoInfos = await Promise.all(uniqueBtcNo.map(addr => getStxInfo(addr)))
  const btcNoAddrsWithData = btcNoEvents
    .filter(evt => (btcToStacks.get(evt.address) || []).length > 0)
    .map(evt => evt.address)
  const uniqueBtcNoAddrs = [...new Set(btcNoAddrsWithData)]
  const btcNoCount = uniqueBtcNoAddrs.length
  const btcNoStacked = btcNoInfos.reduce((sum, i) => sum + i.locked, 0)
  const btcNoUnstacked = 0
  const btcNoTotal = btcNoInfos.reduce((sum, i) => sum + i.locked, 0)
  console.log(`  BTC-only NO  count:         ${btcNoCount}`)
  console.log(`  BTC-only NO  stacked STX:   ${fmtAmt(btcNoStacked)}`)
  console.log(`  BTC-only NO  unstacked STX: ${fmtAmt(btcNoUnstacked)}`)
  console.log(`  BTC-only NO  total STX:     ${fmtAmt(btcNoTotal)}`)

  console.log('\n=== Combined votes summary (STX + BTC) ===')
  const combinedYesCount = stxYesCount + btcYesCount
  const combinedNoCount = stxNoCount + btcNoCount
  const combinedYesStacked = stxYesStacked + btcYesStacked
  const combinedNoStacked = stxNoStacked + btcNoStacked
  const combinedYesUnstacked = stxYesUnstacked + btcYesUnstacked
  const combinedNoUnstacked = stxNoUnstacked + btcNoUnstacked
  const combinedYesTotal = stxYesTotal + btcYesTotal
  const combinedNoTotal = stxNoTotal + btcNoTotal

  console.log(`  Combined YES count:         ${combinedYesCount}`)
  console.log(`  Combined YES stacked STX:   ${fmtAmt(combinedYesStacked)}`)
  console.log(`  Combined YES unstacked STX: ${fmtAmt(combinedYesUnstacked)}`)
  console.log(`  Combined YES total STX:     ${fmtAmt(combinedYesTotal)}`)

  console.log(`  Combined NO  count:         ${combinedNoCount}`)
  console.log(`  Combined NO  stacked STX:   ${fmtAmt(combinedNoStacked)}`)
  console.log(`  Combined NO  unstacked STX: ${fmtAmt(combinedNoUnstacked)}`)
  console.log(`  Combined NO  total STX:     ${fmtAmt(combinedNoTotal)}`)

  const totalVoters = combinedYesCount + combinedNoCount
  const totalStacked = combinedYesStacked + combinedNoStacked
  const totalUnstacked = combinedYesUnstacked + combinedNoUnstacked
  const totalAll = combinedYesTotal + combinedNoTotal

  console.log('\n=== Combined vote percentages ===')
  console.log(`  % YES by count:         ${fmtPct(combinedYesCount / totalVoters * 100)}`)
  console.log(`  % NO  by count:         ${fmtPct(combinedNoCount / totalVoters * 100)}`)
  console.log(`  % YES by stacked STX:   ${fmtPct(combinedYesStacked / totalStacked * 100)}`)
  console.log(`  % NO  by stacked STX:   ${fmtPct(combinedNoStacked / totalStacked * 100)}`)
  console.log(`  % YES by unstacked STX: ${fmtPct(combinedYesUnstacked/ totalUnstacked * 100)}`)
  console.log(`  % NO  by unstacked STX: ${fmtPct(combinedNoUnstacked / totalUnstacked * 100)}`)
  console.log(`  % YES by total STX:     ${fmtPct(combinedYesTotal / totalAll * 100)}`)
  console.log(`  % NO  by total STX:     ${fmtPct(combinedNoTotal / totalAll * 100)}`)

  console.log('\n=== CSV Saving (STX-only voters) ===')
  await writeCsv('sip-31-stx-yes-votes.csv', stxYesInfos)
  await writeCsv('sip-31-stx-no-votes.csv', stxNoInfos)

  console.log('\n=== CSV Saving (STX-only combined voters) ===')

  const voteMeta = new Map()
  for (const evt of firstVotes.values()) {
    if (evt.voteAddr === YES_ADDR || evt.voteAddr === NO_ADDR) {
      voteMeta.set(evt.address, { blockHeight: evt.blockHeight, nonce: evt.nonce, for: evt.voteAddr === YES_ADDR })
    }
  }

  const enrichedVotes = [...stxYesInfos.map(v => ({ ...v, for: true })), ...stxNoInfos.map(v => ({ ...v, for: false }))]

  const enrichedWithMeta = enrichedVotes
    .map(vote => {
      const meta = voteMeta.get(vote.address)
      if (!meta) return null
      return { ...vote, ...meta }
    })
    .filter(Boolean)
    .sort((a, b) => a.blockHeight - b.blockHeight || a.nonce - b.nonce)

  const csvWriter = createObjectCsvWriter({
    path: 'sip-31-stx-combined-votes.csv',
    header: [
      { id: 'address', title: 'address' },
      { id: 'locked', title: 'locked' },
      { id: 'unlocked', title: 'unlocked' },
      { id: 'total', title: 'total' },
      { id: 'for', title: 'for' },
    ]
  })

  await csvWriter.writeRecords(enrichedWithMeta)
  console.log(`  Wrote ${enrichedWithMeta.length.toLocaleString('en-US')} rows to sip-31-stx-combined-votes.csv`)
}

main().catch(err => { console.error('Error in vote tally:', err); process.exit(1) })
