import { each, enumerate } from 'ferrum';

const { assign } = Object;

export class Txt {
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
  h1(txt) {
    return this.writeln(`# ${txt}\n`);
  }

  h2(txt) {
    return this.writeln(`## ${txt}\n`);
  }

  p(txt) {
    return this.writeln(`${txt}\n`);
  }

  link(desc, href) {
    return this.writeln(`[${desc}](${href})`);
  }

  img(alt, href) {
    return this.writeln(`![${alt}](${href})`);
  }
}
