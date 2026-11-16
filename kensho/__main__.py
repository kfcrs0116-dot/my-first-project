"""起動: python -m kensho  （スマホから使う場合: python -m kensho --lan）"""
import argparse

from .app import create_app


def main():
    ap = argparse.ArgumentParser(description="懸賞応募アシスタント")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--lan", action="store_true",
                    help="同じWi-Fiのスマホからアクセスできるようにする（家庭内ネットワークでのみ使用）")
    ap.add_argument("--db", default=None, help="データベースファイルのパス（既定: kensho.db）")
    args = ap.parse_args()
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    print(f"ブラウザで http://{'<このPCのIPアドレス>' if args.lan else '127.0.0.1'}:{args.port} を開いてください")
    create_app(args.db).run(host=host, port=args.port)


if __name__ == "__main__":
    main()
