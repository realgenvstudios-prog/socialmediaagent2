"""
Postgres/R2 client that mimics the supabase-py query-builder interface.
Drop-in replacement: swap `from supabase import create_client` for `from db import create_client`.
"""
import json
import os
import psycopg2
import psycopg2.extras
import boto3
from botocore.config import Config as BotoConfig


# ── JSON adapter ──────────────────────────────────────────────────────────────

def _adapt(v):
    if isinstance(v, (dict, list)):
        return psycopg2.extras.Json(v, dumps=json.dumps)
    return v


# ── Result ────────────────────────────────────────────────────────────────────

class _Result:
    def __init__(self, data=None, count=None):
        self.data = data if data is not None else []
        self.count = count


# ── not_ proxy (handles both .not_("col","is",None) and .not_.is_("col","null")) ──

class _NotProxy:
    def __init__(self, builder):
        self._b = builder

    def __call__(self, col, op, val):
        if op == "is" and val is None:
            self._b._where.append(("is_not_null", col, None))
        elif op == "eq":
            self._b._where.append(("neq", col, val))
        return self._b

    def is_(self, col, val):
        if val == "null":
            self._b._where.append(("is_not_null", col, None))
        return self._b


# ── Query builder ─────────────────────────────────────────────────────────────

class _Query:
    def __init__(self, client, table):
        self._client = client
        self._table = table

    @property
    def _conn(self):
        return self._client._conn
        self._where = []
        self._cols = "*"
        self._order_col = None
        self._order_desc = False
        self._limit_n = None
        self._op = None
        self._data = None
        self._conflict = None
        self._count_mode = False
        self._count_also = False
        self._single_row = False
        self.not_ = _NotProxy(self)

    def select(self, *cols, count=None, head=False):
        self._op = "select"
        self._cols = ", ".join(cols) if len(cols) > 1 else (cols[0] if cols else "*")
        if count == "exact" and head:
            self._count_mode = True
        elif count == "exact":
            self._count_also = True
        return self

    def insert(self, data):
        self._op = "insert"
        self._data = [data] if isinstance(data, dict) else list(data)
        return self

    def update(self, data):
        self._op = "update"
        self._data = data
        return self

    def upsert(self, data, on_conflict=None):
        self._op = "upsert"
        self._data = [data] if isinstance(data, dict) else list(data)
        self._conflict = on_conflict
        return self

    def eq(self, col, val):
        self._where.append(("eq", col, val))
        return self

    def neq(self, col, val):
        self._where.append(("neq", col, val))
        return self

    def gte(self, col, val):
        self._where.append(("gte", col, val))
        return self

    def lt(self, col, val):
        self._where.append(("lt", col, val))
        return self

    def gt(self, col, val):
        self._where.append(("gt", col, val))
        return self

    def is_(self, col, val):
        if val in ("null", None):
            self._where.append(("is_null", col, None))
        return self

    def order(self, col, desc=False, ascending=True):
        self._order_col = col
        self._order_desc = desc or not ascending
        return self

    def limit(self, n):
        self._limit_n = n
        return self

    def single(self):
        self._single_row = True
        return self

    def maybe_single(self):
        self._single_row = True
        return self

    def _build_where(self):
        parts, vals = [], []
        ops = {"eq": "=", "neq": "!=", "gte": ">=", "lt": "<", "gt": ">"}
        for (op, col, val) in self._where:
            if op == "is_null":
                parts.append(f'"{col}" IS NULL')
            elif op == "is_not_null":
                parts.append(f'"{col}" IS NOT NULL')
            elif op in ops:
                parts.append(f'"{col}" {ops[op]} %s')
                vals.append(val)
        return parts, vals

    def _do_execute(self):
        cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        where_parts, where_vals = self._build_where()
        where_sql = "WHERE " + " AND ".join(where_parts) if where_parts else ""

        try:
            if self._op == "select":
                if self._count_mode:
                    cur.execute(f'SELECT COUNT(*)::int AS cnt FROM "{self._table}" {where_sql}', where_vals)
                    return _Result(count=cur.fetchone()["cnt"])

                sql = f'SELECT {self._cols} FROM "{self._table}" {where_sql}'
                if self._order_col:
                    sql += f' ORDER BY "{self._order_col}" {"DESC" if self._order_desc else "ASC"}'
                if self._limit_n is not None:
                    sql += f' LIMIT {int(self._limit_n)}'

                if self._count_also:
                    cur.execute(f'SELECT COUNT(*)::int AS cnt FROM "{self._table}" {where_sql}', where_vals)
                    count_val = cur.fetchone()["cnt"]
                    cur.execute(sql, where_vals)
                    rows = [dict(r) for r in cur.fetchall()]
                    return _Result(data=rows, count=count_val)

                cur.execute(sql, where_vals)
                rows = [dict(r) for r in cur.fetchall()]
                if self._single_row:
                    return _Result(data=rows[0] if rows else None)
                return _Result(data=rows)

            elif self._op == "insert":
                results = []
                for row in self._data:
                    cols = [f'"{k}"' for k in row]
                    vals = [_adapt(v) for v in row.values()]
                    sql = (f'INSERT INTO "{self._table}" ({", ".join(cols)}) '
                           f'VALUES ({", ".join(["%s"] * len(row))}) RETURNING *')
                    cur.execute(sql, vals)
                    r = cur.fetchone()
                    if r:
                        results.append(dict(r))
                self._conn.commit()
                return _Result(data=results)

            elif self._op == "update":
                set_parts = [f'"{k}" = %s' for k in self._data]
                set_vals = [_adapt(v) for v in self._data.values()]
                cur.execute(
                    f'UPDATE "{self._table}" SET {", ".join(set_parts)} {where_sql}',
                    set_vals + where_vals,
                )
                self._conn.commit()
                return _Result(data=[])

            elif self._op == "upsert":
                results = []
                conflict_cols = [c.strip() for c in self._conflict.split(",")] if self._conflict else []
                for row in self._data:
                    cols = [f'"{k}"' for k in row]
                    vals = [_adapt(v) for v in row.values()]
                    update_parts = [f'"{k}" = EXCLUDED."{k}"' for k in row if k not in conflict_cols]
                    if conflict_cols:
                        ct = ", ".join(f'"{c}"' for c in conflict_cols)
                        on_conflict = (f'ON CONFLICT ({ct}) DO UPDATE SET {", ".join(update_parts)}'
                                       if update_parts else f'ON CONFLICT ({ct}) DO NOTHING')
                    else:
                        on_conflict = "ON CONFLICT DO NOTHING"
                    sql = (f'INSERT INTO "{self._table}" ({", ".join(cols)}) '
                           f'VALUES ({", ".join(["%s"] * len(row))}) {on_conflict} RETURNING *')
                    cur.execute(sql, vals)
                    r = cur.fetchone()
                    if r:
                        results.append(dict(r))
                self._conn.commit()
                return _Result(data=results)

        except Exception:
            try:
                self._conn.rollback()
            except Exception:
                pass
            raise
        finally:
            cur.close()

    def execute(self):
        try:
            if self._conn.closed:
                self._client._ensure_connected()
            return self._do_execute()
        except psycopg2.InterfaceError:
            # Connection dropped mid-execute (e.g. after long Whisper run) — reconnect and retry once
            print("  [db] Connection lost — reconnecting and retrying...")
            self._client._ensure_connected()
            return self._do_execute()

        return _Result()


# ── Storage ───────────────────────────────────────────────────────────────────

class _Bucket:
    def __init__(self, r2, bucket, public_url):
        self._r2 = r2
        self._bucket = bucket
        self._public_url = public_url.rstrip("/")

    def get_public_url(self, path):
        return f"{self._public_url}/{path}"

    def upload(self, path, file_obj, content_type="video/mp4"):
        self._r2.upload_fileobj(file_obj, self._bucket, path,
                                ExtraArgs={"ContentType": content_type})

    def remove(self, paths):
        for path in paths:
            try:
                self._r2.delete_object(Bucket=self._bucket, Key=path)
                print(f"  Deleted from R2: {path}")
            except Exception as e:
                print(f"  R2 delete warning ({path}): {e}")


class _Storage:
    def __init__(self, r2, public_url):
        self._r2 = r2
        self._public_url = public_url

    def from_(self, bucket):
        return _Bucket(self._r2, bucket, self._public_url)


# ── Client ────────────────────────────────────────────────────────────────────

class _Client:
    def __init__(self, database_url, r2=None, r2_public_url=None):
        self._database_url = database_url
        self._conn = self._connect()
        if r2:
            self.storage = _Storage(r2, r2_public_url or "")

    def _connect(self):
        # TCP keepalives keep the connection alive during long Whisper transcriptions
        return psycopg2.connect(
            self._database_url,
            keepalives=1,
            keepalives_idle=30,
            keepalives_interval=10,
            keepalives_count=5,
        )

    def _ensure_connected(self):
        if self._conn.closed:
            print("  [db] Connection was closed — reconnecting...")
            self._conn = self._connect()

    def table(self, name):
        self._ensure_connected()
        return _Query(self, name)


def _make_r2():
    account_id = os.environ.get("R2_ACCOUNT_ID")
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    public_url = os.environ.get("R2_PUBLIC_URL", "")
    if not (account_id and access_key and secret_key):
        return None, public_url
    r2 = boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=BotoConfig(signature_version="s3v4"),
    )
    return r2, public_url


def create_client(_url=None, _key=None):
    """Drop-in for supabase.create_client(). Reads DATABASE_URL and R2_* from env."""
    database_url = os.environ["DATABASE_URL"]
    r2, r2_public_url = _make_r2()
    return _Client(database_url, r2=r2, r2_public_url=r2_public_url)
