import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Every class a component uses has a rule, and every rule has a component.
 *
 * Neither direction is checked by anything else. A class with no rule renders
 * as unstyled text and nobody notices until the one screen it is on comes up —
 * `.warning` shipped that way for weeks after a slice-delete took its rule, the
 * loading bar stood still because its keyframes were gone, and three classes
 * were written into components and never styled at all. A rule with no class
 * is quieter but costs the same: the next person edits it, tests it, and it
 * changes nothing.
 *
 * Dependency-free on purpose: no DOM, no CSS parser, no string-literal parser
 * either — prose in comments is full of apostrophes, and a literal scanner that
 * meets one swallows the real literals after it. Comments are stripped and the
 * rest is read as words, generous where a false alarm is cheap and strict where
 * a miss would hide the bug.
 */

const SRC = join(process.cwd(), 'src')

/** Global utilities defined for anything to use, whether or not anything does yet. */
const RESERVED_CSS: Record<string, string> = {
  'sr-only': 'the screen-reader utility in global.css, used by markup as it needs it',
}

/** Classes queried from scripts rather than written into markup. */
const JS_HOOKS: Record<string, string> = {}

const files = (extension: string): string[] =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith(extension))
    .map((name) => join(SRC, name))

/** A class name, or a `--` prefix that a template literal finishes at run time. */
const CLASS = /^\.?[a-z][a-z0-9-]*(?:__[a-z0-9-]+)?(?:--[a-z0-9-]*)?$/

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ')

/** A word as it stands in code: between quotes, whitespace or a `${`. */
const WORD = /(?<=["'`\s{])\.?[a-z][a-z0-9_-]*(?=["'`\s}$])/g

function used(): { strict: Set<string>; source: string } {
  const strict = new Set<string>()
  const sources: string[] = []
  for (const file of [...files('.tsx'), ...files('.ts')]) {
    const source = stripComments(readFileSync(file, 'utf8'))
    sources.push(source)
    // Everything inside a className attribute is a class, whatever its shape.
    for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
      const text = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[^}]*\}/g, ' ')
      for (const word of text.split(/\s+/)) if (word) strict.add(word)
    }
    // A BEM-shaped word or a selector is a class wherever it appears —
    // `classes.push('icon-button--danger')`, `querySelector('.states')`.
    for (const [word] of source.matchAll(WORD)) {
      if ((word.includes('__') || word.includes('--') || word.startsWith('.')) && CLASS.test(word)) {
        strict.add(word.replace(/^\./, ''))
      }
    }
  }
  return { strict, source: sources.join('\n') }
}

function defined(): Set<string> {
  const out = new Set<string>()
  for (const file of files('.css')) {
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*@import[^\n]*$/gm, '')
    for (const match of source.matchAll(/\.([a-zA-Z_][\w-]*)/g)) out.add(match[1] as string)
  }
  return out
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('component classes and stylesheet rules agree', () => {
  const rules = defined()
  const { strict, source } = used()

  it('every class a component writes has a rule', () => {
    const missing = [...strict]
      .filter((name) => !(name in JS_HOOKS))
      .filter((name) => {
        if (rules.has(name)) return false
        // A dynamic modifier: `button--${variant}` is fine if any variant exists.
        if (name.endsWith('--')) return ![...rules].some((rule) => rule.startsWith(name))
        return true
      })
      .sort()
    expect(missing, 'used in a component, styled nowhere').toEqual([])
  })

  it('every rule in the stylesheets is written by some component', () => {
    const unused = [...rules]
      .filter((name) => !(name in RESERVED_CSS))
      .filter((name) => !new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`).test(source))
      .filter((name) => {
        // Covered by a dynamic prefix a component writes.
        const dash = name.lastIndexOf('--')
        return dash < 0 || !strict.has(name.slice(0, dash + 2))
      })
      .sort()
    expect(unused, 'styled, written by no component').toEqual([])
  })
})
