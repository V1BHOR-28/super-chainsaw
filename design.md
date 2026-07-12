# ARIA — Design Document

## Design Philosophy

ARIA's visual identity is **warm amber on charcoal** — a deliberate departure from the cold blue/indigo aesthetic of most AI products. The design communicates "partner, not chatbot" through warmth, serif typography, and subtle ambient effects.

## Color System

### Dark Theme (Default)
| Variable | Value | Usage |
|---|---|---|
| `--aria-bg` | `#0c0a08` | Main background (warm black) |
| `--aria-bg-soft` | `#161210` | Modal/panel backgrounds |
| `--aria-bg-panel` | `#080605` | Input fields, dropdowns |
| `--aria-fg` | `#f5f1eb` | Primary text (warm white) |
| `--aria-fg-muted` | `#a89888` | Secondary text |
| `--aria-fg-dim` | `#5a4d40` | Tertiary text, placeholders |
| `--aria-accent` | `#f59e0b` | Primary amber accent |
| `--aria-accent-glow` | `#fcd34d` | Bright amber (glows, links) |
| `--aria-accent-deep` | `#92400e` | Dark amber (borders, depth) |
| `--aria-accent-bright` | `#fbbf24` | Bright amber (buttons) |
| `--aria-border` | `rgba(252, 211, 77, 0.12)` | Subtle amber borders |
| `--aria-card` | `rgba(252, 211, 77, 0.03)` | Card backgrounds |

### Light Theme
| Variable | Value | Usage |
|---|---|---|
| `--aria-bg` | `#faf8f5` | Main background (warm white) |
| `--aria-bg-soft` | `#f0ede8` | Modal/panel backgrounds |
| `--aria-bg-panel` | `#ffffff` | Input fields, dropdowns |
| `--aria-fg` | `#1a1610` | Primary text (warm black) |
| `--aria-fg-muted` | `#6b5e50` | Secondary text |
| `--aria-fg-dim` | `#a89888` | Tertiary text |
| `--aria-accent` | `#d97706` | Primary amber (darker for contrast) |
| `--aria-accent-glow` | `#b45309` | Bright amber |
| `--aria-accent-deep` | `#92400e` | Dark amber |
| `--aria-accent-bright` | `#f59e0b` | Bright amber |
| `--aria-border` | `rgba(146, 64, 14, 0.15)` | Subtle amber borders |
| `--aria-card` | `rgba(146, 64, 14, 0.04)` | Card backgrounds |

### Color Rules
- **NO indigo or blue** anywhere in the app
- Amber is the ONLY accent color — used for buttons, links, highlights, glows
- Backgrounds are warm (slight orange/brown tint), never pure black or pure gray
- Text is warm (slight cream tint), never pure white
- Borders are subtle amber rgba — visible but not loud

## Typography

### Font Families
| Font | Usage | Source |
|---|---|---|
| **Instrument Serif** | Headings, greetings, book titles | Google Fonts |
| **Space Grotesk** | Body text, UI, buttons | Google Fonts |
| **JetBrains Mono** | Code blocks, usage meter, debug | Google Fonts |

### Font Classes
```css
.font-serif-aria  → Instrument Serif (headings, greetings)
.font-mono-aria   → JetBrains Mono (code, meter)
/* Default body → Space Grotesk */
```

### Type Scale
| Element | Size | Weight | Font |
|---|---|---|---|
| Landing hero | 88px (lg), 64px (md), 40px (sm) | 400 | Instrument Serif italic |
| Greeting | 64px (lg), 40px (sm) | 400 | Instrument Serif italic |
| Section heading | 40px | 400 | Instrument Serif |
| Message content | 15px | 400 | Space Grotesk |
| UI labels | 13px | 500 | Space Grotesk |
| Small text | 11px | 400 | Space Grotesk |
| Micro text | 10px | 600 | Space Grotesk |
| Code | 13px | 400 | JetBrains Mono |

### Typography Rules
- Headings use **Instrument Serif italic** with gradient text effect
- Body text is **Space Grotesk** at 15px with 1.6 line-height
- No font weights above 600 (keep it elegant, not heavy)
- Contractions and casual language in UI (not formal)

## Layout

### Overall Structure
```
┌─────────────────────────────────────────────┐
│ Sidebar (240px)  │  Chat Area (flex-1)      │
│                   │                          │
│  • New button     │  • Top bar (56-60px)    │
│  • Feed button    │    - Menu toggle         │
│  • Conversations  │    - Export button       │
│  • Memory panel   │    - Usage meter         │
│  • Mood panel     │                          │
│  • Reminders      │  • Messages (scroll)    │
│  • User menu      │                          │
│                   │  • Input zone            │
│                   │    - Attach + textarea   │
│                   │    - Globe + Send        │
│                   │    - Feature chips       │
└──────────────────────────────────────────────┘
         Footer (sticky bottom)
```

### Responsive Breakpoints
- **Mobile** (< 640px): Full-screen chat, sidebar hidden (toggle), smaller ball (160px)
- **Tablet** (640-1024px): Sidebar + chat, compact spacing
- **Desktop** (> 1024px): Full sidebar + chat, comfortable spacing

### Key Measurements
- Max message width: 720px (centered)
- Sidebar width: 240px (desktop), full-width (mobile)
- Top bar height: 56px (mobile), 60px (desktop)
- Input border-radius: 24px (rounded-3xl)
- Message bubble border-radius: 16px (rounded-2xl)
- Button border-radius: 8px (rounded-lg)
- Avatar size: 32px (w-8 h-8)
- Icon button size: 32px (w-8 h-8)
- Touch target minimum: 44px

## Components

### Chat Input
- Rounded-3xl container with `--aria-bg-soft` background
- Row of circular buttons: Attach (+) | Textarea | Globe (search) | Send
- Globe highlights amber when search is ON
- Auto-growing textarea (max 140px height)
- Feature chips below (only when no messages): "Remind me to...", "I need advice on...", etc.

### Message Bubbles
- User: amber-tinted background (`rgba(40, 28, 10, 0.5)`), amber border, right-aligned
- ARIA: dark card background (`rgba(22, 18, 16, 0.6)`), subtle border, left-aligned
- ARIA avatar: 32px circle with amber gradient (`.aria-avatar-ai`)
- User avatar: 32px circle with user's initial
- Source bar below ARIA messages (when web search ran): "Found N sources" + favicon pills
- Action row below ARIA messages: Copy + Listen (opacity 60%, 100% on hover)

### Sidebar
- Background: `rgba(0,0,0,0.2)` with right border
- Nav items: icon + label, amber highlight when active
- Conversation list: title + preview, hover shows export/delete
- User menu at bottom: avatar + name + tier + settings

### Modals
- Backdrop: `rgba(8, 6, 4, 0.75)` with `blur(12px)`
- Modal: `--aria-bg-soft` background, 24px border-radius
- Max width: 900px (settings), 560px (feed), 400px (auth)
- Close button: top-right, circular
- Settings: aside (240px) + main (flex-1) layout
- Entrance animation: fade + slide up (0.35s ease)

### Feed Modal
- Tabs: Paste Text | From URL | Upload PDF | Library
- PDF tab: drag-and-drop style file picker (dashed border)
- Progress bars: amber fill on dark track, percentage display
- Library: grouped entries with source icons (📄 PDF, 🌐 URL, 📎 File, 📝 Text)

### Settings Modal
- Tabs: General | Account | Privacy | Customize
- Setting rows: title + description (left) | control (right)
- Controls: dropdown selects, toggle switches
- Model selector: compact dropdown (Claude-style) with badges

## Animations

### Message Entrance
```css
@keyframes aria-msg-enter {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.aria-msg-enter { animation: aria-msg-enter 0.35s ease forwards; }
```

### Modal Entrance
```css
@keyframes aria-fade-slide {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.aria-fade-slide { animation: aria-fade-slide 0.35s ease forwards; }
```

### Streaming Caret
```css
.aria-caret {
  /* Blinking cursor while ARIA is typing */
  animation: aria-caret-blink 0.8s step-end infinite;
}
```

### Thinking Dots
```css
.aria-thinking-dot {
  animation: aria-thinking-pulse 1.4s ease-in-out infinite;
  /* Three dots with staggered delays: 0s, 0.2s, 0.4s */
}
```

### Ambient Glow
```css
.aria-ambient-glow {
  /* Large radial gradient that sits behind the chat */
  /* 600px circle, amber, 8% opacity, centered */
  position: absolute;
  filter: blur(60px);
  pointer-events: none;
}
```

### ARIA Avatar (AI)
```css
.aria-avatar-ai {
  background: radial-gradient(circle at 30% 30%,
    var(--aria-accent-glow),
    var(--aria-accent-bright) 50%,
    var(--aria-accent-deep) 100%);
  box-shadow: 0 0 12px rgba(245, 158, 11, 0.3);
}
```

### Voice Window Aura Ball (disabled but designed)
```css
.aria-voice-ball {
  background: radial-gradient(circle at 35% 35%,
    rgba(252, 211, 77, 0.95),
    rgba(245, 158, 11, 0.85) 35%,
    rgba(180, 100, 0, 0.6) 70%,
    rgba(120, 60, 0, 0.2) 100%);
}
.aria-voice-listening  → gentle pulse (2s, scale 1.0→1.06)
.aria-voice-thinking   → orbiting rotation (1.5s, scale 0.95→1.02)
.aria-voice-speaking   → strong glow + ripple rings (0.8s, scale 1.02→1.08)
```

### Mood Chip Hover
```css
.aria-mood-chip:hover {
  transform: translateY(-2px) scale(1.05);
  transition: transform 0.2s ease, background 0.2s ease, border-color 0.2s ease;
}
```

### Toggle Switch
```css
.aria-toggle input:checked + .aria-toggle-slider {
  background: var(--aria-accent);
  transform: translateX(20px);
}
```

## Iconography

- **Library**: Lucide Icons (consistent stroke width 1.5-2px)
- **Common icons**: Menu, Send, Plus, Globe, X, Clock, Lightbulb, BookOpen, Sparkles, Download, Copy, Check, Brain, Heart, Volume2, Square
- **Sizes**: 13px (action row), 15px (input buttons), 16px (export), 18px (menu), 20px (modal headers), 22px (feature icons)

## Landing Page

- **Served via**: iframe (`/public/aria-landing.html`, 1439 lines)
- **Hero**: "Not a chatbot. A partner." in Instrument Serif italic
- **Live preview**: Interactive terminal mockup
- **Features grid**: 6 cards with SVG icons
- **About section**: Philosophical statement about honesty
- **Footer**: Sticky, "Not a chatbot. A partner." marquee
- **Auth bridge**: postMessage from iframe → parent React auth modal

## Design Rules

1. **Warmth over cold** — amber, not blue. Warm black, not pure black. Cream text, not white.
2. **Serif for emotion, sans for function** — Instrument Serif for headings/greetings, Space Grotesk for everything else.
3. **Subtlety** — borders are rgba with low alpha. Glows are 8-12% opacity. Shadows are soft.
4. **No flat design** — use subtle gradients, blurs, and depth to create dimensionality.
5. **Mobile-first** — everything works on mobile, then enhances for desktop.
6. **Accessibility** — semantic HTML, ARIA labels, keyboard navigation, 44px touch targets.
7. **Sticky footer** — footer always sticks to bottom, pushes down on overflow.
8. **Consistent spacing** — p-4/p-6 for content, gap-4/gap-6 for spacing, max-w-[720px] for messages.
