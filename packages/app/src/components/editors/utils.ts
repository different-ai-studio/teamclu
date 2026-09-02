/**
 * Editor type routing utilities.
 * Determines which editor to use based on file extension.
 */

type EditorType = 'markdown' | 'code';

function isMarkdownExtension(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext === 'md' || ext === 'markdown';
}

/**
 * Determine which editor type to use for a given filename.
 * Markdown files use MarkdownEditor (CodeMirror-based source editor);
 * everything else uses CodeEditor.
 */
export function getEditorType(filename: string): EditorType {
  return isMarkdownExtension(filename) ? 'markdown' : 'code';
}

/**
 * Get the programming language identifier from a filename for syntax highlighting.
 */
export function getLanguageFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    sql: 'sql',
    graphql: 'graphql',
    toml: 'toml',
    ini: 'ini',
    dockerfile: 'dockerfile',
  };
  return languageMap[ext || ''] || 'plaintext';
}

/**
 * Check if file supports preview (HTML or Markdown).
 */
export function supportsPreview(filename: string): 'html' | 'markdown' | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  return null;
}
