import type { Node as TSNode, Tree } from 'web-tree-sitter';
import { isCodeFile } from './fsutil.js';
import type { CallRow, ImportRow, SymbolKind, SymbolRow } from './types.js';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const text = (n: TSNode | null | undefined): string => (n ? n.text : '');

const lineOf = (n: TSNode): number => n.startPosition.row + 1;

/** First line of a node's text, whitespace-collapsed, truncated (no body). */
function preview(n: TSNode, max = 90): string {
  let t = n.text.slice(0, 400);
  const nl = t.indexOf('\n');
  if (nl !== -1) t = t.slice(0, nl);
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Names declared by a top-level declaration node (class, function, const list…). */
function declaredNames(decl: TSNode): string[] {
  if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
    return decl.namedChildren
      .filter((d) => d.type === 'variable_declarator')
      .map((d) => text(d.childForFieldName('name')))
      .filter(Boolean);
  }
  const n = text(decl.childForFieldName('name'));
  return n ? [n] : [];
}

/** Local names bound by an export clause: `export { a as b, type C }` -> ["a", "C"]. */
function exportClauseNames(clause: TSNode): string[] {
  const out: string[] = [];
  for (const spec of clause.namedChildren) {
    if (spec.type === 'export_specifier') {
      const t = text(spec.childForFieldName('name')) || text(spec.namedChild(0));
      if (t && t !== '*') out.push(t.replace(/^type\s+/, ''));
    } else if (spec.type === 'export_identifier') {
      const t = spec.text.replace(/^type\s+/, '');
      if (t && t !== '*' && !t.includes('*')) out.push(t);
    }
  }
  return out;
}

/** Names bound by an import clause: default, namespace, named (post-alias locals). */
function importClauseNames(stmt: TSNode): string[] {
  const out: string[] = [];
  for (const c of stmt.namedChildren) {
    if (c.type !== 'import_clause') continue;
    for (const s of c.namedChildren) {
      if (s.type === 'identifier') {
        out.push(s.text); // default import: `import Def from "..."` (no field name in the grammar)
      } else if (s.type === 'named_imports') {
        for (const sp of s.namedChildren) {
          const local = sp.childForFieldName('alias') ?? sp.childForFieldName('name') ?? sp;
          const t = local.text.replace(/^type\s+/, '');
          if (t && t !== 'type') out.push(t);
        }
      } else if (s.type === 'namespace_import') {
        out.push(text(s.namedChild(0)) || s.text.replace(/^\*\s*as\s+/, ''));
      }
    }
  }
  return [...new Set(out)];
}

const stripQuotes = (s: string): string => s.replace(/^['"]|['"]$/g, '');

/* ------------------------------------------------------------------ */
/* analyzer                                                            */
/* ------------------------------------------------------------------ */

export interface AnalyzeResult {
  symbols: SymbolRow[];
  imports: ImportRow[];
  calls: CallRow[];
}

interface Container {
  name: string;
  kind: SymbolKind | 'interface' | 'type' | 'enum';
}

/**
 * Two-pass analyzer:
 *  pass 1 — top-level export statements -> exported-name set, default flag, re-export imports
 *  pass 2 — full walk -> symbols (top-level + class/interface members), calls, dynamic imports
 */
export function analyze(relPath: string, tree: Tree): AnalyzeResult {
  const symbols: SymbolRow[] = [];
  const imports: ImportRow[] = [];
  const calls: CallRow[] = [];

  const exportedNames = new Set<string>();
  const defaultNames = new Set<string>();

  const specTextOf = (node: TSNode): string => {
    const src = node.childForFieldName('source');
    return src ? stripQuotes(text(src)) : '';
  };

  /* ---------------- pass 1: exports / re-exports / imports ---------------- */

  for (const node of tree.rootNode.namedChildren) {
    if (node.type === 'import_statement') {
      const source = specTextOf(node);
      if (!source) continue;
      const names = importClauseNames(node);
      imports.push({
        file: relPath,
        source,
        names: names.length ? names : ['(side-effect)'],
        line: lineOf(node),
        kind: 'import',
      });
      continue;
    }

    if (node.type !== 'export_statement') continue;

    const isDefault = node.children.some((c) => c.type === 'default');
    const decl = node.namedChildren.find((c) =>
      /^(class_declaration|abstract_class_declaration|function_declaration|generator_function_declaration|lexical_declaration|variable_declaration|type_alias_declaration|interface_declaration|enum_declaration)$/.test(
        c.type,
      ),
    );

    if (decl) {
      const names = declaredNames(decl);
      for (const n of names) {
        exportedNames.add(n);
        if (isDefault) defaultNames.add(n);
      }
      // `export default <expression>` without a declared name
      if (isDefault && names.length === 0) defaultNames.add('(anonymous)');
      continue;
    }

    // `export default <expression>;` / `export default Named;` — a value, not
    // a declaration: index it as a default symbol so a file whose only export
    // is `export default () => ...` is not reported as "no symbols".
    if (isDefault) {
      const value = node.namedChildren[0];
      if (value && !value.childForFieldName('name')) {
        const kind: SymbolKind =
          value.type === 'class' ? 'class'
          : value.type === 'function_expression' || value.type === 'arrow_function' || value.type === 'generator_function' ? 'function'
          : 'const';
        exportedNames.add('(default)');
        defaultNames.add('(default)');
        const n = value.type === 'identifier' ? value.text : '(default)';
        symbols.push({
          file: relPath,
          name: n,
          kind,
          line: lineOf(node),
          endLine: node.endPosition.row + 1,
          sig: `export default ${preview(value, 80)}`,
          exported: 1,
          isDefault: 1,
          isStatic: 0,
          container: null,
        });
      }
      continue;
    }

    // export list, possibly with `from '...'` (re-export)
    const source = specTextOf(node);
    const clause = node.namedChildren.find((c) => c.type === 'export_clause');
    const names = clause ? exportClauseNames(clause) : [];
    const star = /\*\s+as\s+\w/.test(node.text) || /export\s+\*/.test(node.text);
    for (const n of names) exportedNames.add(n);

    if (source) {
      imports.push({
        file: relPath,
        source,
        names: names.length ? names : star ? ['*'] : ['(re-export)'],
        line: lineOf(node),
        kind: 'reexport',
      });
    }
  }

  /* ---------------- pass 2: walk for symbols and calls ---------------- */

  const pushSym = (
    node: TSNode,
    name: string | null,
    kind: SymbolKind,
    sig: string,
    opts: { isStatic?: boolean; container?: string | null } = {},
  ): void => {
    const n = name ?? '(anonymous)';
    // show `export`/`declare default` context when the declaration is the direct child of one
    const p = node.parent;
    const sigFull = p?.type === 'export_statement' && p.firstChild?.type === 'export' && !sig.startsWith('export')
      ? `export ${sig}`
      : sig;
    // the visible range is the declaration itself; an `export ...` wrapper may end later
    const endNode = p?.type === 'export_statement' && p.endPosition.row >= node.endPosition.row ? p : node;
    symbols.push({
      file: relPath,
      name: n,
      kind,
      line: lineOf(node),
      endLine: endNode.endPosition.row + 1,
      sig: sigFull,
      exported: exportedNames.has(n) ? 1 : 0,
      isDefault: defaultNames.has(n) ? 1 : 0,
      isStatic: opts.isStatic ? 1 : 0,
      container: opts.container !== undefined ? opts.container : null,
    });
  };

  const recordCall = (node: TSNode, callee: TSNode | null, container: string | null): void => {
    if (!callee) return;
    if (callee.type === 'function_expression' || callee.type === 'arrow_function') return;
    const t = callee.text.replace(/\s+/g, ' ');
    if (!t || t.startsWith('(')) return;
    calls.push({
      file: relPath,
      line: lineOf(node),
      callee: t.slice(0, 80),
      container,
      kind: node.type === 'new_expression' ? 'new' : callee.type === 'member_expression' ? 'method' : 'call',
    });
  };

  const staticOf = (node: TSNode): boolean => node.children.some((c) => c.type === 'static');

  const visit = (node: TSNode, container: Container | null): void => {
    switch (node.type) {
      /* ---- declarations that become symbols ---- */
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const name = text(node.childForFieldName('name')) || null;
        const kind: SymbolKind = node.type === 'abstract_class_declaration' ? 'abstract class' : 'class';
        pushSym(node, name, kind, preview(node, 80), { container: container?.name ?? null });
        if (name) {
          for (const c of node.namedChildren) {
            if (c.type === 'class_body') for (const m of c.namedChildren) visit(m, { name, kind });
          }
        }
        return;
      }

      case 'function_declaration':
      case 'generator_function_declaration':
      case 'function_signature': {
        if (container) {
          // nested -> not a symbol, but walk the body so its calls are recorded
          const nestedName = text(node.childForFieldName('name')) || '(anonymous)';
          const body = node.childForFieldName('body');
          if (body) visit(body, { name: nestedName, kind: 'function' });
          return;
        }
        const name = text(node.childForFieldName('name')) || null;
        pushSym(node, name, 'function', preview(node, 90));
        const body = node.childForFieldName('body');
        if (body && name) visit(body, { name, kind: 'function' });
        return;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const d of node.namedChildren) {
          if (d.type !== 'variable_declarator') continue;
          const name = text(d.childForFieldName('name'));
          const val = d.childForFieldName('value');
          const isFn =
            val && (val.type === 'arrow_function' || val.type === 'function_expression' || val.type === 'function');
          if (!container && name) {
            pushSym(d, name, isFn ? 'function' : 'const', preview(d, 80));
            if (isFn && val) {
              visit(val, { name, kind: 'function' });
              continue;
            }
          }
          // always walk the initializer: `const x = f()` is a call site too
          if (val) visit(val, container);
        }
        return;
      }

      case 'interface_declaration': {
        const name = text(node.childForFieldName('name')) || null;
        pushSym(node, name, 'interface', preview(node, 80), { container: container?.name ?? null });
        if (name) {
          for (const c of node.namedChildren) {
            if (c.type === 'object_type') {
              for (const m of c.namedChildren) visit(m, { name, kind: 'interface' });
            }
          }
        }
        return;
      }

      case 'type_alias_declaration': {
        const name = text(node.childForFieldName('name')) || null;
        pushSym(node, name, 'type', preview(node, 90), { container: container?.name ?? null });
        return;
      }

      case 'enum_declaration': {
        const name = text(node.childForFieldName('name')) || null;
        pushSym(node, name, 'enum', preview(node, 70), { container: container?.name ?? null });
        const body = node.childForFieldName('body');
        if (body && name) {
          for (const m of body.namedChildren) {
            if (m.type === 'enum_member') {
              pushSym(m, text(m.childForFieldName('name')), 'enum member', preview(m, 50), { container: name });
            }
          }
        }
        return;
      }

      case 'method_definition': {
        const name = text(node.childForFieldName('name')) || null;
        pushSym(node, name, 'method', preview(node, 80), {
          isStatic: staticOf(node),
          container: container?.name ?? null,
        });
        const body = node.childForFieldName('body');
        if (body) visit(body, { name: name ?? '(method)', kind: 'method' });
        return;
      }

      case 'method_signature': {
        if (container?.kind !== 'interface' && container?.kind !== 'type') return;
        pushSym(node, text(node.childForFieldName('name')), 'method', preview(node, 70), {
          container: container.name,
        });
        return;
      }

      case 'field_definition':
      case 'public_field_definition': {
        const name = text(node.childForFieldName('name'));
        pushSym(node, name, 'property', preview(node, 70), {
          isStatic: staticOf(node),
          container: container?.name ?? null,
        });
        const val = node.childForFieldName('value');
        if (val && name) visit(val, { name, kind: 'method' });
        return;
      }

      case 'property_signature': {
        if (container?.kind !== 'interface' && container?.kind !== 'type') return;
        pushSym(node, text(node.childForFieldName('name')), 'property', preview(node, 60), {
          container: container.name,
        });
        return;
      }

      /* ---- calls (and dynamic imports) everywhere ---- */
      case 'call_expression': {
        const callee = node.childForFieldName('function') ?? node.namedChild(0);
        if (callee && callee.text === 'import') {
          const args = callee.nextNamedSibling;
          const arg = args?.namedChild(0);
          const spec = arg ? stripQuotes(arg.text) : '';
          if (spec) {
            imports.push({ file: relPath, source: spec, names: ['(dynamic)'], line: lineOf(node), kind: 'dynamic' });
          }
        } else {
          recordCall(node, callee, container?.name ?? null);
        }
        for (const c of node.namedChildren) visit(c, container);
        return;
      }

      case 'new_expression': {
        recordCall(node, node.childForFieldName('constructor') ?? node.namedChild(0), container?.name ?? null);
        for (const c of node.namedChildren) visit(c, container);
        return;
      }

      /* JSX usage of a component or member component: <AssigneePicker />, <UI.Command> */
      case 'jsx_opening_element': {
        const tag = node.childForFieldName('name');
        if (tag && !/^[a-z]/.test(tag.text)) {
          calls.push({ file: relPath, line: lineOf(node), callee: tag.text.slice(0, 80), container: container?.name ?? null, kind: 'jsx' });
        }
        for (const c of node.namedChildren) visit(c, container);
        return;
      }

      case 'jsx_self_closing_element': {
        const tag = node.childForFieldName('name');
        if (tag && !/^[a-z]/.test(tag.text)) {
          calls.push({ file: relPath, line: lineOf(node), callee: tag.text.slice(0, 80), container: container?.name ?? null, kind: 'jsx' });
        }
        for (const c of node.namedChildren) visit(c, container);
        return;
      }

      /* ---- containers without symbols: keep walking ---- */
      default: {
        for (const c of node.namedChildren) visit(c, container);
      }
    }
  };

  for (const stmt of tree.rootNode.namedChildren) visit(stmt, null);

  return { symbols, imports, calls };
}

export function detectLang(relPath: string): 'ts' | 'tsx' | null {
  if (!isCodeFile(relPath)) return null;
  return relPath.endsWith('.tsx') ? 'tsx' : 'ts';
}