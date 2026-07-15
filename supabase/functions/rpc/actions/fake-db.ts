/**
 * Base en mémoire minimaliste imitant le sous-ensemble de l'API supabase-js
 * utilisé par les actions serveur. RÉSERVÉ AUX TESTS (jamais importé en prod).
 */
type Row = Record<string, unknown>;

function match(row: Row, filters: [string, string, unknown][]): boolean {
  return filters.every(([col, op, val]) => {
    const v = row[col];
    if (op === 'eq') return v === val;
    if (op === 'neq') return v !== val;
    if (op === 'is') return v === val; // is(null)
    if (op === 'in') return Array.isArray(val) && (val as unknown[]).includes(v);
    if (op === 'gte') return String(v) >= String(val);
    if (op === 'lte') return String(v) <= String(val);
    return true;
  });
}

class Query {
  filters: [string, string, unknown][] = [];
  private opType: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] | null = null;
  private wantSingle: 'maybe' | 'one' | null = null;
  private wantSelect = false;
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private store: Record<string, Row[]>;
  private table: string;

  constructor(store: Record<string, Row[]>, table: string) {
    this.store = store;
    this.table = table;
  }

  select(_c?: string) { this.wantSelect = true; return this; }
  insert(p: Row | Row[]) { this.opType = 'insert'; this.payload = p; return this; }
  update(p: Row) { this.opType = 'update'; this.payload = p; return this; }
  delete() { this.opType = 'delete'; return this; }
  eq(c: string, v: unknown) { this.filters.push([c, 'eq', v]); return this; }
  neq(c: string, v: unknown) { this.filters.push([c, 'neq', v]); return this; }
  is(c: string, v: unknown) { this.filters.push([c, 'is', v]); return this; }
  in(c: string, v: unknown[]) { this.filters.push([c, 'in', v]); return this; }
  gte(c: string, v: unknown) { this.filters.push([c, 'gte', v]); return this; }
  lte(c: string, v: unknown) { this.filters.push([c, 'lte', v]); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.orderCol = c; this.orderAsc = o?.ascending !== false; return this; }
  limit(n: number) { this.limitN = n; return this; }
  range() { return this; }
  maybeSingle() { this.wantSingle = 'maybe'; return this; }
  single() { this.wantSingle = 'one'; return this; }

  private rows(): Row[] { return (this.store[this.table] ??= []); }

  private run(): { data: unknown; error: { message: string } | null; count?: number } {
    const rows = this.rows();
    if (this.opType === 'insert') {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload!];
      for (const it of items) rows.push(structuredClone(it));
      return { data: this.wantSelect ? items.map((r) => structuredClone(r)) : null, error: null };
    }
    if (this.opType === 'update') {
      const matched = rows.filter((r) => match(r, this.filters));
      for (const r of matched) Object.assign(r, structuredClone(this.payload));
      return { data: this.wantSelect ? matched.map((r) => structuredClone(r)) : null, error: null };
    }
    if (this.opType === 'delete') {
      this.store[this.table] = rows.filter((r) => !match(r, this.filters));
      return { data: null, error: null };
    }
    // select
    let res = rows.filter((r) => match(r, this.filters)).map((r) => structuredClone(r));
    if (this.orderCol) {
      const col = this.orderCol;
      res.sort((a, b) => (String(a[col] ?? '') < String(b[col] ?? '') ? -1 : 1) * (this.orderAsc ? 1 : -1));
    }
    if (this.limitN != null) res = res.slice(0, this.limitN);
    if (this.wantSingle) return { data: res[0] ?? null, error: null };
    return { data: res, error: null, count: res.length };
  }

  then<T>(onF: (v: { data: unknown; error: { message: string } | null; count?: number }) => T) {
    return Promise.resolve(this.run()).then(onF);
  }
}

export class FakeDB {
  store: Record<string, Row[]> = {
    cargaisons: [], conteneurs: [], declarations: [], stock: [], stock_annonce: [], audit_log: [], profils: [],
  };
  private compteurs: Record<string, number> = { SEQ: 0, SEQ_RPT: 0 };

  from(table: string) {
    // La vue résumé est calculée à la volée depuis cargaisons.
    if (table === 'v_cargaisons_resume') {
      const q = new Query(this.store, '__resume');
      this.store['__resume'] = this.store['cargaisons'].map((c) => this.resume(c));
      return q;
    }
    return new Query(this.store, table);
  }

  private resume(c: Row): Row {
    return { ...c };
  }

  rpc(name: string, args: Record<string, unknown>) {
    let data: unknown = null;
    if (name === 'fn_next_ref') {
      const cle = String(args['p_cle']);
      this.compteurs[cle] = (this.compteurs[cle] ?? 0) + 1;
      data = `${args['p_prefix']}-${new Date().getFullYear()}-${String(this.compteurs[cle]).padStart(6, '0')}`;
    } else if (name === 'fn_apurer_inc') {
      const d = this.store['declarations'].find((x) => x['cle'] === args['p_cle']);
      if (d) {
        d['conteneurs_apures'] = Number(d['conteneurs_apures'] || 0) + Number(args['p_nb']);
        data = Math.max(0, Number(d['nombre_conteneurs'] || 0) - Number(d['conteneurs_apures']));
      } else data = 0;
    } else if (name === 'fn_lier_stock') {
      const s = this.store['stock'].find((x) => x['numero_tc'] === args['p_tc']);
      if (s) { s['statut'] = 'Dépoté'; s['date_depote'] = new Date().toISOString(); s['cargaison_id'] = args['p_cargaison_id']; }
    }
    return Promise.resolve({ data, error: null });
  }

  // Auth admin non utilisé dans les tests de cycle de vie.
  auth = { admin: {} };
}
