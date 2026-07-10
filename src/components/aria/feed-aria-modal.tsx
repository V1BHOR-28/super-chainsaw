'use client'

import { useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { BookOpen, Link2, FileText, X, Loader2, Trash2, BookMarked, Upload, FileUp } from 'lucide-react'
import { toast } from 'sonner'
import { useAriaStore } from '@/lib/store'

type FeedTab = 'text' | 'url' | 'file' | 'library'
type FeedState = 'idle' | 'reading' | 'refining' | 'embedding' | 'done'

const STATE_LABELS: Record<FeedState, string> = {
  idle: '',
  reading: 'ARIA is reading the document...',
  refining: 'ARIA is analyzing what she learned...',
  embedding: 'ARIA is storing it in her library...',
  done: 'Done! ARIA now knows this.',
}

export function FeedAriaModal() {
  const { feedAriaOpen, setFeedAriaOpen } = useAriaStore()
  const [tab, setTab] = useState<FeedTab>('text')
  const [textContent, setTextContent] = useState('')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [state, setState] = useState<FeedState>('idle')
  const [knowledge, setKnowledge] = useState<Array<{ id: string; title: string; source: string; contentLength: number }>>([])
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

    setState('reading')
    if (tab === 'url' || tab === 'file') {
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
      if (!res.ok) {
        throw new Error(data.error || 'Upload failed')
      }

      setState('done')
      toast.success("ARIA has learned this. She'll use it in your conversations.")

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
              { id: 'file' as const, label: 'Upload PDF', icon: FileUp },
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

            {/* FILE TAB (PDF / TXT upload) */}
            {tab === 'file' && (
              <div className="space-y-4">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.txt,.md,text/plain,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) {
                      if (f.size > 10 * 1024 * 1024) {
                        toast.error('File too large (max 10MB)')
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
                        Drop a PDF or text file here
                      </div>
                      <div className="text-[11px] mt-1" style={{ color: 'var(--aria-fg-dim)' }}>
                        PDF, TXT, or Markdown · Max 10MB
                      </div>
                    </div>
                  )}
                </button>
                <p className="text-[11px]" style={{ color: 'var(--aria-fg-dim)' }}>
                  ARIA will read the entire document, learn its contents, and use it as context when you ask related questions. Perfect for books, manuals, study notes, research papers.
                </p>
                <button
                  onClick={handleSubmit}
                  disabled={!file || state !== 'idle'}
                  className="w-full py-3 rounded-xl flex items-center justify-center gap-2 text-[14px] font-medium transition-all disabled:opacity-50"
                  style={{
                    background: file ? 'var(--aria-accent)' : 'var(--aria-fg-dim)',
                    color: 'var(--aria-bg)',
                    border: 'none',
                    cursor: file ? 'pointer' : 'not-allowed',
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

            {/* LIBRARY TAB */}
            {tab === 'library' && (
              <div className="space-y-2 max-h-[350px] overflow-y-auto">
                {knowledge.length === 0 ? (
                  <div className="text-center py-12" style={{ color: 'var(--aria-fg-dim)' }}>
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
                          {k.source === 'url' ? '🌐 URL' : k.source === 'pdf' ? '📄 PDF' : k.source === 'file' ? '📎 File' : '📝 Text'} · {k.contentLength.toLocaleString()} chars
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
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

export default FeedAriaModal
