import sql from "./db"

type Row = Record<string, unknown>

interface QueryResult<T = Row> {
  data: T[] | T | null
  error: null
  count: number | null
}

type CondOp = "eq" | "neq" | "gte" | "lt" | "is_not_null" | "is_null"

interface Cond {
  op: CondOp
  col: string
  val: unknown
}

class Query<T = Row> implements PromiseLike<QueryResult<T>> {
  private _table: string
  private _cols = "*"
  private _conds: Cond[] = []
  private _orderCol: string | null = null
  private _orderAsc = true
  private _lim: number | null = null
  private _offset: number | null = null
  private _isSingle = false
  private _countOnly = false

  constructor(table: string) {
    this._table = table
  }

  select(cols = "*", opts?: { count?: string; head?: boolean }) {
    this._cols = cols
    if (opts?.count === "exact" && opts?.head) this._countOnly = true
    return this
  }

  eq(col: string, val: unknown) {
    this._conds.push({ op: "eq", col, val })
    return this
  }

  neq(col: string, val: unknown) {
    this._conds.push({ op: "neq", col, val })
    return this
  }

  gte(col: string, val: unknown) {
    this._conds.push({ op: "gte", col, val })
    return this
  }

  lt(col: string, val: unknown) {
    this._conds.push({ op: "lt", col, val })
    return this
  }

  not(col: string, op: string, val: unknown) {
    if (op === "is" && val === null) this._conds.push({ op: "is_not_null", col, val: null })
    return this
  }

  is(col: string, val: null) {
    this._conds.push({ op: "is_null", col, val: null })
    return this
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this._orderCol = col
    this._orderAsc = opts?.ascending !== false
    return this
  }

  limit(n: number) {
    this._lim = n
    return this
  }

  range(from: number, to: number) {
    this._offset = from
    this._lim = to - from + 1
    return this
  }

  single() {
    this._isSingle = true
    return this
  }

  then<TRes1 = QueryResult<T>, TRes2 = never>(
    onfulfilled?: ((v: QueryResult<T>) => TRes1 | PromiseLike<TRes1>) | null,
    onrejected?: ((r: unknown) => TRes2 | PromiseLike<TRes2>) | null,
  ): Promise<TRes1 | TRes2> {
    return this._run().then(onfulfilled, onrejected)
  }

  private async _run(): Promise<QueryResult<T>> {
    const params: unknown[] = []
    const wheres: string[] = []
    const opMap: Record<string, string> = { eq: "=", neq: "!=", gte: ">=", lt: "<" }

    for (const c of this._conds) {
      if (c.op === "is_not_null") {
        wheres.push(`"${c.col}" IS NOT NULL`)
      } else if (c.op === "is_null") {
        wheres.push(`"${c.col}" IS NULL`)
      } else {
        params.push(c.val)
        wheres.push(`"${c.col}" ${opMap[c.op]} $${params.length}`)
      }
    }

    const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : ""

    if (this._countOnly) {
      const rows = await sql.unsafe(
        `SELECT COUNT(*)::int AS cnt FROM "${this._table}" ${where}`,
        params as never[],
      )
      return { data: null, error: null, count: Number(rows[0]?.cnt ?? 0) }
    }

    let q = `SELECT ${this._cols} FROM "${this._table}" ${where}`
    if (this._orderCol) q += ` ORDER BY "${this._orderCol}" ${this._orderAsc ? "ASC" : "DESC"}`
    if (this._lim !== null) q += ` LIMIT ${this._lim}`
    if (this._offset !== null) q += ` OFFSET ${this._offset}`

    const rows = (await sql.unsafe(q, params as never[])) as T[]

    if (this._isSingle) return { data: rows[0] ?? null, error: null, count: null }
    return { data: rows, error: null, count: null }
  }
}

class SupabaseCompat {
  from(table: string) {
    return new Query(table)
  }
}

export const supabase = new SupabaseCompat()
