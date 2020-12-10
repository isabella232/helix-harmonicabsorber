import { each, enumerate } from 'ferrum';

const { assign } = Object;

export class Txt {
  static new() {
    return new Txt();
  }

  constructor() {
    assign(this, {  buf: [] });
  }

  write_seq(seq) {
    each(seq, v => this.buf.push(v));
    return this;
  }

  write(...toks) {
    return this.write_seq(toks);
  }

  writeln(...toks) {
    return this.write(...toks, '\n');
  }

  write_list(seq, opts = {}) {
    const { delim = '\n' } = opts;
    each(seq, l => {
      this.write(l)
      this.write(delim)
    });
    return this;
  }

  write_table(seq, opts = {}) {
    const { delim = '\n', col_sep = ' ' } = opts;
    each(seq, col => {
      this.write_with_sep(col, col_sep);
      this.write(delim);
    });
    return this;
  }

  write_with_sep(seq, sep) {
    each(enumerate(seq), ([idx, v]) => {
      if (idx !== 0)
        this.buf.push(sep);
      this.buf.push(v);
    });
    return this;
  }

  toString() {
    return this.buf.join('');
  }
}

export class Markdown extends Txt {
  static new() {
    return new Markdown();
  }

  h1(txt) {
    return this.writeln(`\n# ${txt}\n`);
  }

  h2(txt) {
    return this.writeln(`\n## ${txt}\n`);
  }

  p(txt) {
    return this.writeln(`${txt}\n`);
  }

  link(desc, href) {
    return this.write(`[${desc}](${href})`);
  }

  img(alt, href) {
    return this.write(`![${alt}](${href})`);
  }

  code(lang, c) {
    return this.writeln('\n```', lang, '\n', c, '\n```\n');
  }
}
