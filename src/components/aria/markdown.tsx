'use client'

import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

/**
 * ARIA's markdown renderer — renders ARIA's replies with code highlighting,
 * links, lists, tables, images. Preserves the warm amber aesthetic via
 * the `.aria-prose` class defined in globals.css.
 */
export function Markdown({ content }: { content: string }) {
  return (
    <div className="aria-prose">
      <ReactMarkdown
        urlTransform={(url) => url}
        components={{
          // Code blocks with copy button
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '')
            const isBlock = String(children).includes('\n')
            if (!isBlock) {
              return (
                <code
                  className={className}
                  style={{
                    background: 'var(--aria-card)',
                    border: '1px solid var(--aria-border)',
                    borderRadius: '4px',
                    padding: '1px 5px',
                    fontSize: '0.9em',
                  }}
                  {...props}
                >
                  {children}
                </code>
              )
            }
            return (
              <CodeBlock language={match?.[1] ?? 'text'} value={String(children).replace(/\n$/, '')} />
            )
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            )
          },
          img({ src, alt }) {
            return (
              <img
                src={typeof src === 'string' ? src : ''}
                alt={alt || ''}
                className="rounded-xl border my-3 max-w-full"
                style={{ borderColor: 'var(--aria-border)' }}
              />
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }
  return (
    <div
      className="my-3"
      style={{
        border: '1px solid var(--aria-border)',
        borderRadius: '12px',
        overflow: 'hidden',
      }}
    >
      <div
        className="flex items-center justify-between"
        style={{
          background: 'var(--aria-bg-panel)',
          borderBottom: '1px solid var(--aria-border)',
          padding: '6px 12px',
          borderRadius: '12px 12px 0 0',
        }}
      >
        <span
          className="text-xs uppercase tracking-wide"
          style={{ color: 'var(--aria-fg-dim)' }}
        >
          {language}
        </span>
        <button
          onClick={copy}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded-md"
          style={{
            background: 'rgba(245,158,11,0.1)',
            color: 'var(--aria-accent-glow)',
            border: '1px solid var(--aria-border)',
          }}
          aria-label="Copy code"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={vscDarkPlus}
        customStyle={{
          background: 'var(--aria-bg-panel)',
          borderRadius: '0 0 12px 12px',
          fontSize: '13px',
          margin: 0,
        }}
      >
        {value}
      </SyntaxHighlighter>
    </div>
  )
}
