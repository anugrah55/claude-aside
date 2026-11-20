import { expect, test } from 'claude-code/testing'

import { elapsed, findImagePaths, formatForMain, isSafeShell, parseAsk, pastedRefs, questionText, resolvePath } from '../hooks/lib'

test('image paths are found however the terminal wrote them', async () => {
  const text = String.raw`look at /Users/a/My\ Shot.png and "/tmp/two words.jpg" or ./ui/logo.webp, not notes.txt or v1.5`
  expect(findImagePaths(text).map(found => found.path)).toEqual([
    '/Users/a/My Shot.png',
    '/tmp/two words.jpg',
    './ui/logo.webp',
  ])
  expect(findImagePaths('no pictures here, just a.pngx and b.png.bak')).toEqual([])
})

test('paths resolve against home and the working directory', async () => {
  expect(resolvePath('~/Desktop/s.png', '/Users/me', '/proj')).toBe('/Users/me/Desktop/s.png')
  expect(resolvePath('./ui/a.png', '/Users/me', '/proj/')).toBe('/proj/ui/a.png')
  expect(resolvePath('file:///Users/me/My%20Shot.png', '/Users/me', '/proj')).toBe('/Users/me/My Shot.png')
  expect(resolvePath('/abs/b.png', '/Users/me', '/proj')).toBe('/abs/b.png')
})

test('pasted placeholders are numbered and named in the question the model reads', async () => {
  expect(pastedRefs('a [Image #2] b [Image #3]')).toEqual([2, 3])
  const images = [{ path: '/tmp/p.png', label: 'pasted image 2' }]
  expect(questionText('see [Image #2] and [Image #3]', images)).toBe(
    'see [pasted image 2: /tmp/p.png] and [Image #3]',
  )
})

test('only plainly read-only shell commands pass', async () => {
  for (const command of [
    'grep -rn "saveDraft" src',
    'rg -n checkout --type ts',
    'find . -name "*.tsx" | head -20',
    'git log --oneline -5',
    'git diff HEAD~1 -- src/app.ts',
    'cat package.json | jq .dependencies',
    'ls -la src',
    'npm --version',
    String.raw`grep -rn -i "total\|reduce\|price" --include=*.js . | grep -v node_modules | head -40`,
    'grep -rn "a|b" src',
    'grep -r cartTotal . 2>/dev/null | head',
    'rg qty src 2>&1 | head -5',
    "echo '$(not run)'",
    'git -C src log --oneline -3',
  ]) {
    expect(isSafeShell(command)).toBe(true)
  }
  for (const command of [
    'npm --version | tee v.txt',
    'echo hi > notes.txt',
    'ls && rm -rf build',
    'cat a; rm b',
    'grep x $(rm -rf ~)',
    'grep x `whoami`',
    'find . -name "*.log" -delete',
    'find . -exec rm {} +',
    'rg --pre ./run.sh foo',
    'git push origin main',
    'git checkout -- .',
    'sort -o out.txt in.txt',
    'npm install',
    'PAGER=cat git log',
    './script.sh',
    'sed -i s/a/b/ file',
    'curl https://example.com',
    'cat a >/dev/null; rm b',
    'echo "$(rm x)"',
    'git -c core.fsmonitor=evil status',
    'git grep -Ovim foo',
    'grep x file > out.txt',
    'grep "unclosed file',
    'ls |',
  ]) {
    expect(isSafeShell(command)).toBe(false)
  }
})

test('a leading -q or --deep picks the mode and is taken off the question', async () => {
  expect(parseAsk('-q why?')).toEqual({ question: 'why?', mode: 'quick' })
  expect(parseAsk('--quick   why?')).toEqual({ question: 'why?', mode: 'quick' })
  expect(parseAsk('--deep where?')).toEqual({ question: 'where?', mode: 'deep' })
  expect(parseAsk('what does -q mean?')).toEqual({ question: 'what does -q mean?', mode: 'deep' })
  expect(parseAsk('-quiet please')).toEqual({ question: '-quiet please', mode: 'deep' })
})

test('times read like a person says them, and answers quote cleanly into the prompt', async () => {
  expect(elapsed(0, 7_400)).toBe('7s')
  expect(elapsed(0, 72_000)).toBe('1m 12s')
  expect(formatForMain('why NaN?', 'qty is undefined\n\nsee cart.js:12')).toBe(
    'Context from a side question I asked (/aside): "why NaN?"\n> qty is undefined\n>\n> see cart.js:12\n\n',
  )
})
