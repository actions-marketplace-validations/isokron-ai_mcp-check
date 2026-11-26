import sqlite3

conn = sqlite3.connect("users.db")


def read_user(user_id):
    return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def purge_user(user_id):
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
