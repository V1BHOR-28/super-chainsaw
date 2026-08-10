'use client'

import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { BookOpen, Link2, FileText, X, Loader2, Trash2, BookMarked, Upload, FileUp, Quote, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { useAriaStore } from '@/lib/store'
import { chunkText } from '@/lib/chunk-text'
import { analyzeEpub } from '@/lib/abm-api'

type FeedTab = 'text' | 'url' | 'file' | 'library' | 'quotes'
type FeedState = 'idle' | 'reading' | 'refining' | 'embedding' | 'parsing' | 'indexing' | 'done'

const STATE_LABELS: Record<FeedState, string> = {
  idle: '',
  reading: 'ARIA is reading the document...',
  refining: 'ARIA is analyzing what she learned...',
  embedding: 'ARIA is storing it in her library...',
  parsing: 'Parsing the EPUB file...',
  indexing: 'Indexing chunks into ARIA\'s library...',
  done: 'Done! ARIA now knows this.',
}

export function FeedAriaModal() {
  const { feedAriaOpen, setFeedAriaOpen, setActiveWorkspace } = useAriaStore()
  const [tab, setTab] = useState<FeedTab>('text')
  const [textContent, setTextContent] = useState('')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [state, setState] = useState<FeedState>('idle')
  const [knowledge, setKnowledge] = useState<Array<{ id: string; title: string; source: string; contentLength: number; chunks?: number }>>([])
  // EPUB upload progress
  const [epubUploading, setEpubUploading] = useState(false)
  const [indexProgress, setIndexProgress] = useState<{ current: number; total: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = async () => {
    if (tab === 'text' && !textContent.trim()) {
      toast.error('Paste some text first')
      return
    }
    if (tab === 'url' && !url.trim()) {
      toast.error('Paste a URL first')
      return
    }
    if (tab === 'file' && !file) {
      toast.error('Choose a file first')
      return
    }

    // === EPUB + PDF PIPELINE ===
    // Both EPUBs and PDFs are parsed server-side by the Flask audiobook-maker service.
    // The analyze endpoint parses the book and returns the chapter list.
    // TTS generation happens via the Flask /api/generate endpoint.
    if (tab === 'file' && file && (file.name.toLowerCase().endsWith('.epub') || file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/epub+zip' || file.type === 'application/pdf')) {
      return handleBookUpload(file)
    }

    // === EXISTING PATH (text, URL, TXT files) ===
    setState('reading')
    if (tab === 'url') {
      setTimeout(() => setState('refining'), 2000)
      setTimeout(() => setState('embedding'), 4000)
    } else {
      setState('refining')
      setTimeout(() => setState('embedding'), 2000)
    }

    try {
      let res: Response
      if (tab === 'file' && file) {
        const formData = new FormData()
        formData.append('file', file)
        res = await fetch('/api/knowledge', {
          method: 'POST',
          body: formData,
        })
      } else {
        res = await fetch('/api/knowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: tab,
            content: textContent,
            url: url,
          }),
        })
      }

      const data = await res.json()

      // 409 = duplicate title. Ask the user to confirm re-upload, then resend
      // with forceReupload:true so the backend skips the de-dup check.
      if (res.status === 409 && data.error === 'duplicate') {
        const ok = window.confirm(data.message || 'You have already fed ARIA something with this title. Upload anyway?')
        if (!ok) {
          setState('idle')
          return
        }
        // Resend with forceReupload
        if (tab === 'file' && file) {
          const formData = new FormData()
          formData.append('file', file)
          formData.append('forceReupload', 'true')
          res = await fetch('/api/knowledge', { method: 'POST', body: formData })
        } else {
          res = await fetch('/api/knowledge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: tab, content: textContent, url: url, forceReupload: true }),
          })
        }
        // Re-parse the response from the forced upload
        const forcedData = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(forcedData.error || 'Upload failed')
        Object.assign(data, forcedData)
      } else if (!res.ok) {
        throw new Error(data.error || 'Upload failed')
      }

      // Signal silent truncation — the doc was longer than ARIA's per-upload cap.
      if (data.truncated === true) {
        toast.warning('Only part of this document was saved — it\'s longer than ARIA can currently hold in one go.')
      }

      setState('done')
      const chunkInfo = data.knowledge.chunks > 1 ? ` (${data.knowledge.chunks} sections indexed)` : ''
      toast.success(`ARIA has learned this.${chunkInfo} She'll use it in your conversations.`)

      setKnowledge(prev => [{
        id: data.knowledge.id,
        title: data.knowledge.title,
        source: data.knowledge.source,
        contentLength: data.knowledge.contentLength,
      }, ...prev])

      setTextContent('')
      setUrl('')
      setFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''

      setTimeout(() => {
        setState('idle')
        setTab('library')
      }, 1500)
    } catch (err) {
      setState('idle')
      toast.error((err as Error).message)
    }
  }

  /**
   * EPUB upload pipeline:
   * 1. Send the .epub file to the Flask audiobook-maker service for parsing
   * 2. Flask parses the TOC + chapter text and returns the chapter list
   * 3. TTS generation happens via the Flask /api/generate endpoint
   *
   * EPUBs are parsed server-side by the Flask audiobook-maker service, unlike the old
   * PDF pipeline which parsed in the browser. This is simpler and more
   * reliable — EPUBs are structured XML, not scanned images.
   */
  const handleBookUpload = async (bookFile: File) => {
    setEpubUploading(true)
    setState('parsing')

    try {
      // Call the Flask audiobook-maker service via the /api/abm proxy.
      // The Flask app parses the EPUB and returns the chapter list + metadata,
      // stashing the parsed state in-memory keyed by the returned job_id.
      const data = await analyzeEpub(bookFile)

      // Also store the full text as Knowledge for chat/RAG
      // (so ARIA can still reference the book in conversations).
      // The analyze response doesn't include full chapter text (only word/char
      // counts + titles), so we can't build RAG chunks from it here. RAG indexing
      // is skipped for EPUBs in the new Flask-based architecture — the book is
      // parsed on the Flask service, not in the Next.js process. If you need RAG
      // over EPUB content, upload the book as text via the "Paste Text" tab instead.
      try {
        // Use the preview text from the analyze response as a minimal RAG entry
        // so the book is at least searchable by title + preview.
        const previewText = data.preview_text || ''
        if (previewText.length > 100) {
          const chunks = chunkText(`${data.title}\n\n${previewText}`)
          const documentId = `epub-${data.job_id}`
          const BATCH_SIZE = 10

          for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
            const batchChunks = chunks.slice(i, i + BATCH_SIZE)
            await fetch('/api/knowledge/batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                documentId,
                title: data.title,
                source: 'epub',
                chunks: batchChunks,
                batchIndex: Math.floor(i / BATCH_SIZE),
                totalBatches: Math.ceil(chunks.length / BATCH_SIZE),
                totalChunks: chunks.length,
                chunkOffset: i,
              }),
            })
          }
        }
      } catch (ragErr) {
        console.error('[feed-aria] RAG indexing failed (non-blocking):', ragErr)
        // Non-blocking — the audiobook was already created successfully
      }

      setState('done')
      toast.success(`"${data.title}" parsed with ${data.total_chapters} chapters! Opening audiobook library…`)

      setFile(null)
      setEpubUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''

      // Close the Feed ARIA modal and switch to the Audiobooks workspace
      // so the user sees their book appear in the library, ready for chapter selection.
      setTimeout(() => {
        setState('idle')
        setFeedAriaOpen(false)
        setActiveWorkspace('audiobooks')
      }, 2000)
    } catch (err) {
      setState('idle')
      setEpubUploading(false)
      toast.error((err as Error).message)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/knowledge/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed')
      setKnowledge(prev => prev.filter(k => k.id !== id))
      toast.success('Knowledge removed')
    } catch {
      toast.error('Could not delete')
    }
  }

  const loadKnowledge = async () => {
    try {
      const res = await fetch('/api/knowledge')
      if (!res.ok) return
      const data = await res.json()
      setKnowledge(data.knowledge || [])
    } catch {
      // silent
    }
  }

  // Load knowledge when switching to library tab
  const handleTabChange = (newTab: FeedTab) => {
    setTab(newTab)
    if (newTab === 'library') loadKnowledge()
  }

  if (!feedAriaOpen) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[200] flex items-center justify-center p-4"
        style={{ background: 'rgba(8, 6, 4, 0.75)', backdropFilter: 'blur(12px)' }}
        onClick={(e) => { if (e.target === e.currentTarget) setFeedAriaOpen(false) }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="relative w-full max-w-[560px] rounded-3xl overflow-hidden"
          style={{
            background: 'var(--aria-bg-soft)',
            border: '1px solid var(--aria-border)',
            boxShadow: '0 25px 80px rgba(0,0,0,0.5), 0 0 60px rgba(245,158,11,0.08)',
          }}
        >
          {/* Close */}
          <button
            onClick={() => setFeedAriaOpen(false)}
            className="absolute right-4 top-4 z-10 w-8 h-8 rounded-full flex items-center justify-center transition-colors"
            style={{ color: 'var(--aria-fg-muted)', background: 'transparent', border: '1px solid transparent' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--aria-card)'; e.currentTarget.style.borderColor = 'var(--aria-border)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' }}
          >
            <X size={18} />
          </button>

          {/* Header */}
          <div className="p-8 pb-0">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(245,158,11,0.1)', color: 'var(--aria-accent-glow)' }}>
                <BookOpen size={20} strokeWidth={1.5} />
              </div>
              <div>
                <h2 className="font-serif-aria text-3xl leading-none">Feed ARIA</h2>
                <p className="text-[13px] mt-1" style={{ color: 'var(--aria-fg-muted)' }}>Teach her something she should know.</p>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 px-8 mt-4 flex-wrap">
            {([
              { id: 'text' as const, label: 'Paste Text', icon: FileText },
              { id: 'url' as const, label: 'From URL', icon: Link2 },
              { id: 'file' as const, label: 'Upload EPUB', icon: FileUp },
              { id: 'quotes' as const, label: 'Quotes', icon: Quote },
              { id: 'library' as const, label: 'Library', icon: BookMarked },
            ]).map(t => {
              const Icon = t.icon
              const active = tab === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => handleTabChange(t.id)}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all"
                  style={{
                    background: active ? 'rgba(245,158,11,0.08)' : 'transparent',
                    color: active ? 'var(--aria-accent-glow)' : 'var(--aria-fg-muted)',
                    border: 'none',
                  }}
                >
                  <Icon size={15} strokeWidth={1.5} />
                  {t.label}
                </button>
              )
            })}
          </div>

          {/* Content */}
          <div className="p-8 pt-4">
            {/* TEXT TAB */}
            {tab === 'text' && (
              <div className="space-y-4">
                <textarea
                  value={textContent}
                  onChange={(e) => setTextContent(e.target.value)}
                  placeholder="Paste anything — an article, player stats, match schedule, study notes, a recipe... ARIA will read it, refine any spelling mistakes, and remember it."
                  rows={8}
                  className="w-full rounded-xl p-4 text-[14px] outline-none transition-colors resize-none placeholder:text-[var(--aria-fg-dim)] focus:border-[rgba(245,158,11,0.45)]"
                  style={{
                    background: 'var(--aria-bg-panel)',
                    border: '1px solid var(--aria-border)',
                    color: 'var(--aria-fg)',
                    fontFamily: 'inherit',
                    lineHeight: 1.6,
                  }}
                />
                <p className="text-[11px]" style={{ color: 'var(--aria-fg-dim)' }}>
                  ARIA will automatically fix spelling and grammar before storing this.
                </p>
                <button
                  onClick={handleSubmit}
                  disabled={!textContent.trim() || state !== 'idle'}
                  className="w-full py-3 rounded-xl flex items-center justify-center gap-2 text-[14px] font-medium transition-all disabled:opacity-50"
                  style={{
                    background: textContent.trim() ? 'var(--aria-accent)' : 'var(--aria-fg-dim)',
                    color: 'var(--aria-bg)',
                    border: 'none',
                    cursor: textContent.trim() ? 'pointer' : 'not-allowed',
                  }}
                >
                  {state !== 'idle' && state !== 'done' ? (
                    <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> {STATE_LABELS[state]}</span>
                  ) : state === 'done' ? (
                    <span>✓ {STATE_LABELS.done}</span>
                  ) : (
                    <span>Feed ARIA</span>
                  )}
                </button>
              </div>
            )}

            {/* URL TAB */}
            {tab === 'url' && (
              <div className="space-y-4">
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/article-about-fifa-fantasy"
                  className="w-full rounded-xl p-4 text-[14px] outline-none transition-colors placeholder:text-[var(--aria-fg-dim)] focus:border-[rgba(245,158,11,0.45)]"
                  style={{
                    background: 'var(--aria-bg-panel)',
                    border: '1px solid var(--aria-border)',
                    color: 'var(--aria-fg)',
                    fontFamily: 'inherit',
                  }}
                />
                <p className="text-[11px]" style={{ color: 'var(--aria-fg-dim)' }}>
                  ARIA will fetch the page, extract the text, refine it, and store it. She'll use this knowledge when you ask related questions.
                </p>
                <button
                  onClick={handleSubmit}
                  disabled={!url.trim() || state !== 'idle'}
                  className="w-full py-3 rounded-xl flex items-center justify-center gap-2 text-[14px] font-medium transition-all disabled:opacity-50"
                  style={{
                    background: url.trim() ? 'var(--aria-accent)' : 'var(--aria-fg-dim)',
                    color: 'var(--aria-bg)',
                    border: 'none',
                    cursor: url.trim() ? 'pointer' : 'not-allowed',
                  }}
                >
                  {state !== 'idle' && state !== 'done' ? (
                    <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> {STATE_LABELS[state]}</span>
                  ) : state === 'done' ? (
                    <span>✓ {STATE_LABELS.done}</span>
                  ) : (
                    <span>Fetch & Feed ARIA</span>
                  )}
                </button>
              </div>
            )}

            {/* FILE TAB (EPUB upload) */}
            {tab === 'file' && (
              <div className="space-y-4">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".epub,.pdf,application/epub+zip,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) {
                      // EPUBs are constrained to 50MB by the Flask /api/analyze endpoint.
                      // Reject them client-side to save a round-trip and a confusing 413.
                      // Only accept EPUB files
                      const isBook = f.name.toLowerCase().endsWith('.epub') || f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/epub+zip' || f.type === 'application/pdf'
                      if (!isBook) {
                        toast.error('Please upload an EPUB or PDF file.')
                        return
                      }
                      if (f.size > 50 * 1024 * 1024) {
                        toast.error('EPUB too large (50MB max)')
                        return
                      }
                      setFile(f)
                    }
                  }}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full rounded-xl p-8 flex flex-col items-center justify-center gap-3 transition-all"
                  style={{
                    background: 'var(--aria-bg-panel)',
                    border: `1.5px dashed ${file ? 'var(--aria-accent)' : 'var(--aria-border)'}`,
                    cursor: 'pointer',
                  }}
                >
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center"
                    style={{
                      background: file ? 'rgba(245,158,11,0.15)' : 'var(--aria-card)',
                      color: file ? 'var(--aria-accent-glow)' : 'var(--aria-fg-muted)',
                    }}
                  >
                    {file ? <FileText size={22} /> : <Upload size={22} />}
                  </div>
                  {file ? (
                    <div className="text-center">
                      <div className="text-[14px] font-medium" style={{ color: 'var(--aria-fg)' }}>
                        {file.name}
                      </div>
                      <div className="text-[11px] mt-1" style={{ color: 'var(--aria-fg-dim)' }}>
                        {(file.size / 1024).toFixed(1)} KB · Click to change
                      </div>
                    </div>
                  ) : (
                    <div className="text-center">
                      <div className="text-[14px] font-medium" style={{ color: 'var(--aria-fg)' }}>
                        Drop an EPUB file here
                      </div>
                      <div className="text-[11px] mt-1" style={{ color: 'var(--aria-fg-dim)' }}>
                        EPUB files only · Max 50MB
                      </div>
                    </div>
                  )}
                </button>
                <p className="text-[11px]" style={{ color: 'var(--aria-fg-dim)' }}>
                  Upload an EPUB file and ARIA will parse its table of contents, extract each chapter, and generate an audiobook you can listen to. The text is also indexed for chat context.
                </p>

                {/* EPUB upload progress */}
                {state === 'parsing' && epubUploading && (
                  <div className="rounded-xl p-4" style={{ background: 'var(--aria-bg-panel)', border: '1px solid var(--aria-border)' }}>
                    <div className="flex items-center gap-3">
                      <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--aria-accent-glow)' }} />
                      <span className="text-[12px] font-medium" style={{ color: 'var(--aria-fg)' }}>
                        Parsing EPUB and extracting chapters...
                      </span>
                    </div>
                    <p className="text-[10px] mt-2" style={{ color: 'var(--aria-fg-dim)' }}>
                      Reading the EPUB's table of contents and extracting chapter text.
                    </p>
                  </div>
                )}

                {state === 'indexing' && indexProgress && (
                  <div className="rounded-xl p-4" style={{ background: 'var(--aria-bg-panel)', border: '1px solid var(--aria-border)' }}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[12px] font-medium" style={{ color: 'var(--aria-fg)' }}>
                        Indexing chunk {indexProgress.current} of {indexProgress.total}
                      </span>
                      <span className="text-[12px] font-mono-aria" style={{ color: 'var(--aria-accent-glow)' }}>
                        {Math.round((indexProgress.current / indexProgress.total) * 100)}%
                      </span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(252,211,77,0.08)' }}>
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{ width: `${(indexProgress.current / indexProgress.total) * 100}%`, background: 'var(--aria-accent)' }}
                      />
                    </div>
                    <p className="text-[10px] mt-2" style={{ color: 'var(--aria-fg-dim)' }}>
                      ARIA is storing what she learned. This won't take long.
                    </p>
                  </div>
                )}

                <button
                  onClick={handleSubmit}
                  disabled={!file || (state !== 'idle' && state !== 'done')}
                  className="w-full py-3 rounded-xl flex items-center justify-center gap-2 text-[14px] font-medium transition-all disabled:opacity-50"
                  style={{
                    background: file ? 'var(--aria-accent)' : 'var(--aria-fg-dim)',
                    color: 'var(--aria-bg)',
                    border: 'none',
                    cursor: file && state === 'idle' ? 'pointer' : 'not-allowed',
                  }}
                >
                  {state !== 'idle' && state !== 'done' ? (
                    <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> {STATE_LABELS[state]}</span>
                  ) : state === 'done' ? (
                    <span>✓ Uploaded! Generating audiobook…</span>
                  ) : (
                    <span>Upload & Generate Audiobook</span>
                  )}
                </button>
              </div>
            )}

            {/* QUOTES TAB */}
            {tab === 'quotes' && (
              <QuotesTab />
            )}

            {/* LIBRARY TAB */}
            {tab === 'library' && (
              <div className="space-y-2 max-h-[350px] overflow-y-auto">
                {knowledge.length === 0 ? (
                  <div className="text-center py-8" style={{ color: 'var(--aria-fg-dim)' }}>
                    <BookMarked size={32} strokeWidth={1} className="mx-auto mb-3 opacity-30" />
                    <p className="text-[13px]">Nothing in ARIA's library yet.</p>
                    <p className="text-[12px] mt-1">Feed her some knowledge to get started.</p>
                  </div>
                ) : (
                  knowledge.map(k => (
                    <div
                      key={k.id}
                      className="flex items-start gap-3 rounded-xl p-3"
                      style={{ background: 'var(--aria-card)', border: '1px solid var(--aria-border)' }}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium truncate" style={{ color: 'var(--aria-fg)' }}>
                          {k.title}
                        </div>
                        <div className="text-[11px] mt-1" style={{ color: 'var(--aria-fg-dim)' }}>
                          {k.source === 'url' ? '🌐 URL' : k.source === 'pdf' ? '📄 PDF' : k.source === 'file' ? '📎 File' : '📝 Text'} · {k.contentLength.toLocaleString()} chars{k.chunks && k.chunks > 1 ? ` · ${k.chunks} sections` : ''}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDelete(k.id)}
                        className="p-1.5 rounded-md transition-colors"
                        style={{ color: 'var(--aria-fg-dim)' }}
                        onMouseEnter={(e) => e.currentTarget.style.color = '#ef4444'}
                        onMouseLeave={(e) => e.currentTarget.style.color = 'var(--aria-fg-dim)'}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                )}
                {/* Surprise Me is always available — not just an empty-state nudge.
                    Pulling it out of the knowledge.length === 0 conditional means the
                    user can keep discovering new books even after their library has items. */}
                <div className="flex justify-center pt-2">
                  <SurpriseButton />
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

function QuotesTab() {
  const [quotes, setQuotes] = useState<Array<{ id: string; text: string; bookTitle: string | null; author: string | null; note: string | null }>>([])
  const [text, setText] = useState('')
  const [bookTitle, setBookTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const loadQuotes = async () => {
    try {
      const res = await fetch('/api/quotes')
      if (!res.ok) return
      const data = await res.json()
      setQuotes(data.quotes || [])
    } catch {
      // silent
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => { loadQuotes() }, [])

  const handleSave = async () => {
    const trimmed = text.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      const res = await fetch('/api/quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed, bookTitle: bookTitle.trim() || undefined, author: author.trim() || undefined }),
      })
      if (!res.ok) throw new Error('failed')
      const data = await res.json()
      setQuotes(prev => [data.quote, ...prev])
      setText('')
      setBookTitle('')
      setAuthor('')
      toast.success('Quote saved')
    } catch {
      toast.error('Could not save quote')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/quotes/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('failed')
      setQuotes(prev => prev.filter(q => q.id !== id))
      toast.success('Quote removed')
    } catch {
      toast.error('Could not delete')
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Save a quote — paste the passage that stuck with you..."
          rows={3}
          className="w-full rounded-xl p-3 text-[14px] outline-none transition-colors resize-none placeholder:text-[var(--aria-fg-dim)] focus:border-[rgba(245,158,11,0.45)]"
          style={{ background: 'var(--aria-bg-panel)', border: '1px solid var(--aria-border)', color: 'var(--aria-fg)', fontFamily: 'inherit', lineHeight: 1.6 }}
        />
        <div className="flex gap-2">
          <input
            value={bookTitle}
            onChange={(e) => setBookTitle(e.target.value)}
            placeholder="Book (optional)"
            className="flex-1 rounded-lg px-3 py-2 text-[13px] outline-none transition-colors placeholder:text-[var(--aria-fg-dim)] focus:border-[rgba(245,158,11,0.45)]"
            style={{ background: 'var(--aria-bg-panel)', border: '1px solid var(--aria-border)', color: 'var(--aria-fg)', fontFamily: 'inherit' }}
          />
          <input
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Author (optional)"
            className="flex-1 rounded-lg px-3 py-2 text-[13px] outline-none transition-colors placeholder:text-[var(--aria-fg-dim)] focus:border-[rgba(245,158,11,0.45)]"
            style={{ background: 'var(--aria-bg-panel)', border: '1px solid var(--aria-border)', color: 'var(--aria-fg)', fontFamily: 'inherit' }}
          />
        </div>
        <button
          onClick={handleSave}
          disabled={!text.trim() || saving}
          className="w-full py-2.5 rounded-xl flex items-center justify-center gap-2 text-[14px] font-medium transition-all disabled:opacity-50"
          style={{ background: text.trim() ? 'var(--aria-accent)' : 'var(--aria-fg-dim)', color: 'var(--aria-bg)', border: 'none', cursor: text.trim() ? 'pointer' : 'not-allowed' }}
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : null}
          {saving ? 'Saving...' : 'Save Quote'}
        </button>
      </div>
      {!loaded ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={18} className="animate-spin" style={{ color: 'var(--aria-fg-dim)' }} />
        </div>
      ) : quotes.length === 0 ? (
        <div className="text-center py-8" style={{ color: 'var(--aria-fg-dim)' }}>
          <Quote size={28} strokeWidth={1} className="mx-auto mb-2 opacity-30" />
          <p className="text-[13px]">No saved quotes yet.</p>
        </div>
      ) : (
        <div className="space-y-2 max-h-[250px] overflow-y-auto">
          {quotes.map(q => (
            <div key={q.id} className="rounded-xl p-3" style={{ background: 'var(--aria-card)', border: '1px solid var(--aria-border)' }}>
              <div className="flex items-start gap-2">
                <p className="flex-1 text-[13px] leading-relaxed m-0 italic" style={{ color: 'var(--aria-fg)' }}>
                  "{q.text}"
                </p>
                <button
                  onClick={() => handleDelete(q.id)}
                  className="p-1 rounded-md transition-colors shrink-0"
                  style={{ color: 'var(--aria-fg-dim)' }}
                  onMouseEnter={(e) => e.currentTarget.style.color = '#ef4444'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'var(--aria-fg-dim)'}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {(q.bookTitle || q.author) && (
                <p className="text-[11px] mt-1 m-0" style={{ color: 'var(--aria-fg-dim)' }}>
                  {q.bookTitle && `— ${q.bookTitle}`}{q.author && `, ${q.author}`}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SurpriseButton() {
  const [loading, setLoading] = useState(false)
  const [suggestion, setSuggestion] = useState<{ title: string; author: string; why: string; sourceUrl: string | null; canAddFullText: boolean } | null>(null)
  const [adding, setAdding] = useState(false)
  const [excludeTitles, setExcludeTitles] = useState<string[]>([])

  const handleSurprise = async () => {
    setLoading(true)
    setSuggestion(null)
    try {
      const res = await fetch('/api/library-suggest/surprise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ excludeTitles }),
      })
      const data = await res.json()
      if (data.suggestion) {
        setSuggestion(data.suggestion)
        setExcludeTitles(prev => [...prev, data.suggestion.title])
      } else {
        toast.error('Could not generate a suggestion right now')
      }
    } catch {
      toast.error('Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  const handleAdd = async () => {
    if (!suggestion?.sourceUrl) return
    setAdding(true)
    try {
      const res = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'url', url: suggestion.sourceUrl, title: `${suggestion.title} by ${suggestion.author}` }),
      })
      if (!res.ok && res.status !== 409) {
        // Surface the route's specific error message (e.g. a timeout on a huge
        // book vs. a 404 vs. an extraction failure) instead of a one-size-fits-all
        // generic string, so the user knows whether a retry is likely to help.
        let detail = ''
        try {
          const body = await res.json()
          detail = body?.error ?? body?.message ?? ''
        } catch {}
        throw new Error(detail || 'failed')
      }
      toast.success(`Added "${suggestion.title}" to your library`)
      setSuggestion(null)
    } catch (err) {
      const detail = err instanceof Error && err.message && err.message !== 'failed'
        ? err.message
        : 'Could not fetch the full text — try again'
      toast.error(detail)
    } finally {
      setAdding(false)
    }
  }

  const handleAddInterest = async () => {
    if (!suggestion) return
    setAdding(true)
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `Interested in reading "${suggestion.title}" by ${suggestion.author}`,
          category: 'reading-list',
        }),
      })
      if (!res.ok && res.status !== 409) throw new Error('failed')
      toast.success('Added to your reading interests')
      setSuggestion(null)
    } catch {
      toast.error('Could not save — try again')
    } finally {
      setAdding(false)
    }
  }

  if (suggestion) {
    return (
      <div className="mt-4 rounded-xl p-4 text-left" style={{ background: 'var(--aria-card)', border: '1px solid rgba(245,158,11,0.25)' }}>
        <div className="flex items-start gap-2 mb-2">
          <Sparkles size={14} style={{ color: 'var(--aria-accent-glow)' }} className="mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium m-0" style={{ color: 'var(--aria-fg)' }}>{suggestion.title}</p>
            <p className="text-[12px] m-0" style={{ color: 'var(--aria-fg-muted)' }}>by {suggestion.author}</p>
          </div>
        </div>
        {suggestion.why && (
          <p className="text-[12px] m-0 mb-3 italic" style={{ color: 'var(--aria-fg-muted)' }}>{suggestion.why}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {suggestion.canAddFullText && suggestion.sourceUrl && (
            <button
              onClick={handleAdd}
              disabled={adding}
              className="text-xs px-3 py-1.5 rounded-lg transition-colors"
              style={{ background: 'var(--aria-accent)', color: 'var(--aria-bg)' }}
            >
              {adding ? <Loader2 size={12} className="animate-spin" /> : 'Add to my library'}
            </button>
          )}
          <button
            onClick={handleAddInterest}
            disabled={adding}
            className="text-xs px-3 py-1.5 rounded-lg transition-colors"
            style={{ border: '1px solid var(--aria-border)', color: 'var(--aria-fg)' }}
          >
            {adding ? <Loader2 size={12} className="animate-spin" /> : null}
            Save as interest
          </button>
          <button
            onClick={() => { setSuggestion(null); handleSurprise() }}
            disabled={loading || adding}
            className="text-xs px-3 py-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--aria-fg-dim)' }}
          >
            Not for me, try again
          </button>
        </div>
        {!suggestion.canAddFullText && (
          <p className="text-[11px] mt-2 m-0" style={{ color: 'var(--aria-fg-dim)' }}>
            This one isn&apos;t available as free full text, but you can save it as a reading interest.
          </p>
        )}
      </div>
    )
  }

  return (
    <button
      onClick={handleSurprise}
      disabled={loading}
      className="mt-4 text-xs px-3 py-2 rounded-lg flex items-center gap-1.5 transition-colors mx-auto"
      style={{ border: '1px solid var(--aria-border)', color: 'var(--aria-accent-glow)', background: 'transparent' }}
    >
      {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
      {loading ? 'Finding something...' : 'Surprise me with a classic'}
    </button>
  )
}

export default FeedAriaModal
