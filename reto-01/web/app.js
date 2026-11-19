/* ── State ─────────────────────────────────────────────────── */
const sessionId = crypto.randomUUID()
let isLoading   = false

/* ── DOM refs ──────────────────────────────────────────────── */
const chatArea    = document.getElementById('chat-area')
const chatForm    = document.getElementById('chat-form')
const userInput   = document.getElementById('user-input')
const sendBtn     = document.getElementById('send-btn')
const statusBadge = document.getElementById('status-badge')
const statusText  = document.getElementById('status-text')
const confirmBanner = document.getElementById('confirmation-banner')

/* ── Init ──────────────────────────────────────────────────── */
checkHealth()

/* ── Health check ──────────────────────────────────────────── */
async function checkHealth() {
  try {
    const res  = await fetch('/api/health')
    const data = await res.json()
    if (data.ok) {
      setStatus('ok', `${data.provider} · ${data.model}`)
    } else {
      setStatus('error', 'Backend error')
    }
  } catch {
    setStatus('error', 'Sin conexión')
  }
}

function setStatus(state, label) {
  statusBadge.className = `status-badge status-${state}`
  statusText.textContent = label
}

/* ── Form submit ───────────────────────────────────────────── */
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const text = userInput.value.trim()
  if (!text || isLoading) return
  sendMessage(text)
})

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    chatForm.dispatchEvent(new Event('submit'))
  }
})

/* Auto-grow textarea */
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto'
  userInput.style.height = Math.min(userInput.scrollHeight, 140) + 'px'
})

/* ── Send message ──────────────────────────────────────────── */
async function sendMessage(text) {
  isLoading = true
  setInputEnabled(false)
  hideConfirmBanner()

  /* Remove welcome screen on first message */
  const welcome = chatArea.querySelector('.welcome-msg')
  if (welcome) welcome.remove()

  appendUserBubble(text)
  userInput.value = ''
  userInput.style.height = 'auto'

  const thinkingEl = appendThinking()

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: text }),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`HTTP ${res.status}: ${errText}`)
    }

    const data = await res.json()
    thinkingEl.remove()

    appendAgentMessage(data.reply, data.toolCalls ?? [], data.needsConfirmation ?? false)

    if (data.needsConfirmation) showConfirmBanner()

  } catch (err) {
    thinkingEl.remove()
    appendErrorBubble(err.message ?? 'Error desconocido')
  } finally {
    isLoading = false
    setInputEnabled(true)
    userInput.focus()
  }
}

/* ── Rendering ─────────────────────────────────────────────── */
function appendUserBubble(text) {
  const row = el('div', 'msg-row user')
  row.innerHTML = `
    <span class="msg-label">Tú</span>
    <div class="msg-bubble">${escHtml(text)}</div>
  `
  chatArea.appendChild(row)
  scrollBottom()
}

function appendThinking() {
  const row = el('div', 'msg-row agent thinking')
  row.innerHTML = `
    <span class="msg-label">Agente</span>
    <div class="thinking-bubble">
      <span></span><span></span><span></span>
    </div>
  `
  chatArea.appendChild(row)
  scrollBottom()
  return row
}

function appendAgentMessage(reply, toolCalls, needsConfirmation) {
  const row = el('div', 'msg-row agent')

  /* Tool calls section */
  if (toolCalls.length > 0) {
    const wrap = el('div', 'tool-calls-wrap')
    toolCalls.forEach(tc => wrap.appendChild(renderToolCall(tc)))
    row.appendChild(wrap)
  }

  /* Reply bubble */
  const label  = el('span', 'msg-label')
  label.textContent = 'Agente'

  const bubble = el('div', 'msg-bubble' + (needsConfirmation ? ' needs-confirmation' : ''))
  bubble.innerHTML = renderMarkdown(reply)

  row.appendChild(label)
  row.appendChild(bubble)
  chatArea.appendChild(row)
  scrollBottom()
}

function renderToolCall(tc) {
  const wrap    = el('div', 'tool-call')
  const isOk    = tc.ok !== false
  const statusClass = isOk ? 'ok' : 'err'
  const statusLabel = isOk ? '✓ ok' : '✗ error'

  /* Pretty-print args and result */
  let argsStr, resultStr
  try { argsStr = JSON.stringify(tc.args, null, 2) } catch { argsStr = String(tc.args) }
  try {
    const parsed = JSON.parse(tc.result)
    resultStr = JSON.stringify(parsed, null, 2)
  } catch {
    resultStr = tc.result
  }

  /* Truncate long results for display */
  const displayResult = resultStr.length > 600
    ? resultStr.slice(0, 600) + '\n… (truncado)'
    : resultStr

  wrap.innerHTML = `
    <div class="tool-call-header">
      <span class="tool-call-icon">🔧</span>
      <span class="tool-call-name">${escHtml(tc.name)}</span>
      <span class="tool-call-status ${statusClass}">${statusLabel}</span>
      <span class="tool-call-chevron">▾</span>
    </div>
    <div class="tool-call-body">
      <div>
        <div class="tool-call-section-label">Argumentos</div>
        <pre class="tool-call-code">${escHtml(argsStr)}</pre>
      </div>
      <div>
        <div class="tool-call-section-label">Resultado</div>
        <pre class="tool-call-code">${escHtml(displayResult)}</pre>
      </div>
    </div>
  `

  wrap.querySelector('.tool-call-header').addEventListener('click', () => {
    wrap.classList.toggle('open')
  })

  return wrap
}

function appendErrorBubble(msg) {
  const row = el('div', 'msg-row agent')
  row.innerHTML = `
    <span class="msg-label">Sistema</span>
    <div class="msg-bubble" style="border-color:#ef4444;color:#fca5a5">
      ⚠ ${escHtml(msg)}
    </div>
  `
  chatArea.appendChild(row)
  scrollBottom()
}

/* ── Confirmation banner ───────────────────────────────────── */
function showConfirmBanner()  { confirmBanner.classList.remove('hidden') }
function hideConfirmBanner()  { confirmBanner.classList.add('hidden') }

/* ── Helpers ───────────────────────────────────────────────── */
function el(tag, cls) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  return e
}

function scrollBottom() {
  chatArea.scrollTop = chatArea.scrollHeight
}

function setInputEnabled(enabled) {
  userInput.disabled = !enabled
  sendBtn.disabled   = !enabled
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Minimal Markdown → HTML (no external library).
 * Supports: **bold**, *italic*, `code`, - lists, numbered lists, blank-line paragraphs.
 */
function renderMarkdown(text) {
  let html = escHtml(text)

  /* Code blocks (``` … ```) */
  html = html.replace(/```[\s\S]*?```/g, (m) => {
    const inner = m.slice(3, -3).replace(/^[a-z]*\n/, '')
    return `<pre style="background:var(--tool-bg);border:1px solid var(--tool-border);border-radius:6px;padding:8px 10px;font-family:var(--font-mono);font-size:12px;overflow-x:auto;margin:6px 0"><code>${inner}</code></pre>`
  })

  /* Inline code */
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  /* Bold */
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

  /* Italic */
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  /* Unordered list items */
  html = html.replace(/^[ \t]*[-*] (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>[\s\S]*?<\/li>)(?=\n<li>|$)/g, '<ul>$1</ul>')

  /* Ordered list items */
  html = html.replace(/^[ \t]*\d+\. (.+)$/gm, '<li>$1</li>')

  /* Paragraphs (blank lines) */
  html = html
    .split(/\n{2,}/)
    .map(block => {
      block = block.trim()
      if (!block) return ''
      if (block.startsWith('<ul>') || block.startsWith('<pre>') || block.startsWith('<li>')) return block
      return `<p>${block.replace(/\n/g, '<br>')}</p>`
    })
    .join('\n')

  return html
}
