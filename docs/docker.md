# Dockerに関する用意

ファクトリーを動かすために、ホストに用意するDockerのもの(イメージ、コンテナ、ボリューム、ネットワーク)と、その作り方、作り直す時機、片付け方をまとめます。

起動の手順そのものは `README.md`、なぜこの形にしたかは `docs/design.md` の「ワーカーの封じ込め」にあります。例では、製品のリポジトリを `owner/name`、Composeのプロジェクト名を `<プロジェクト>` と書きます。プロジェクト名は、既定ではこのリポジトリを置いたディレクトリの名前です。

```bash
docker compose config --format json | jq -r .name    # プロジェクト名を確かめる
```

## 全体像

```text
ホスト
├─ 常駐するコンテナ(Composeが管理)
│   ├─ office    事務局。GitHubのトークンとDBを持つ
│   ├─ launcher  起動係。Dockerソケットと、Claudeのトークンを持つ
│   └─ proxy     ワーカーの唯一の出口
└─ 使い捨てのコンテナ(起動係がステップごとに立てる)
    └─ ワーカー  製品ごとのイメージから立ち、終わると消える
```

## イメージ

イメージは3種類あります。定義を持つ側と、作り直す時機が、それぞれ違います。

| イメージ | 定義の場所 | 作り方 | 作り直すとき |
| --- | --- | --- | --- |
| 常駐用(`<プロジェクト>-office`、`-launcher`、`-proxy`) | このリポジトリの `Dockerfile`(1つのファイルに、3つのターゲット) | `docker compose up -d --build` | このリポジトリのコード、指示書、マイグレーションを更新したとき |
| ワーカーの基本(既定の名前は `factory-worker`) | このリポジトリの `docker/worker.Dockerfile` | `docker compose build worker-image` | Claude Code の版を上げるとき。土台の `node:22-slim` を更新したいとき |
| 製品用のワーカー(`factory-built:<ハッシュ>`) | 製品リポジトリの Dockerfile(製品の `factory.yml` の `worker.dockerfile` が指すファイル) | 起動係が、必要なときに自動でビルドする(下の「製品用のイメージ」) | 自動。製品の定義か、ワーカーの基本が変わると、次の実行の前にビルドし直される |

常駐用の3つは、中身がほとんど同じです。違いは、事務局にだけ git があり、起動係にだけ docker コマンドがあることです。指示書(`prompts/`)は常駐用のイメージに入っているので、指示書だけを変えたときも、常駐用を作り直します。

### ワーカーの基本と、製品用の関係

製品用のイメージは、ワーカーの基本を土台にして、その製品に要るものだけを足したものです。親子の関係にあります。

| | ワーカーの基本 | 製品用 |
| --- | --- | --- |
| 入っているもの | Node、git、Claude Code、権限のないユーザー(`node`、uid 1000) | 基本のすべてと、製品の検査コマンド(`factory.yml` の `commands`)が使うツール |
| 責任を持つ側 | ファクトリー | 製品 |
| 製品ごとの違い | なし | あり |

- **使われるのは、製品ごとに1つです。** 製品の `factory.yml` に `worker.dockerfile` があれば、そこからビルドした製品用のイメージを使います。なければ、設定(`config/factory.config.yml`)の製品の項目の `worker_image` を、それもなければ全体の `worker_image`(既定は `factory-worker`)を使います。製品用のビルドの土台も、この `worker_image` です。
- **どのステップも、同じイメージで動きます。** `plan`、`implement`、`review`(Claudeを呼ぶ)と、`verify`(検査コマンドを実行する)です。Claudeが実装の途中でテストを走らせるので、Claudeを呼ぶステップにも製品のツールが要ります。
- **製品用は、ビルドした時点の基本を取り込みます。** 製品用の名前は、基本のイメージのIDと Dockerfile の本文から決まります。基本を作り直すと名前が変わるので、次の実行の前に、起動係が製品用をビルドし直します。手で作り直す必要はありません。
- **起動係は、イメージを外から取ってきません**(`--pull=never`)。設定にある名前のイメージが手元になければ、ワーカーを立てられず、ステップが失敗します。起動係は、起動のときにこれを確かめて、ないイメージをログに出します(下の「ワーカーの基本の名前」)。

### ワーカーの基本の名前

名前は、設定(`config/factory.config.yml`)の `worker_image` で決めます。起動係がワーカーを立てるときに使うのは、この値です。

- **既定(`factory-worker`)のまま使うなら、何も書きません。** `docker compose build worker-image` が、同じ名前でイメージを作ります。
- **別の名前にするなら、設定の `worker_image` に書き、`.env` の `WORKER_IMAGE` にも同じ値を書きます。** `WORKER_IMAGE` は、ビルドで付ける名前を設定に合わせるためのものです。Composeは設定ファイルを読めないので、ここだけは手で揃えます。

2つが食い違うと、ビルドしたイメージと、起動係が探すイメージの名前が合いません。起動係は、起動のときに、設定にあるイメージ(全体の `worker_image` のうち実際に使われるものと、製品ごとの `worker_image`)が手元にあるかを確かめ、なければ警告をログに出します。

```bash
docker compose logs launcher | grep launcher.image_missing
```

```json
{"time":"2026-01-01T00:00:00.000Z","level":"warn","event":"launcher.image_missing","image":"factory-worker","repos":["owner/name"]}
```

- `image` が手元にないイメージ、`repos` がそれを使う製品です。
- 起動係は止まりません。イメージのある製品の実行は続きます。イメージのない製品は、ワーカーを立てるステップで失敗します。
- 確かめるのは、起動のときだけです。後からイメージを作れば、次のステップから使われます(再起動は要りません)。

### 製品用のイメージ

定義は、製品リポジトリに置き、製品の `factory.yml` の `worker.dockerfile` に場所を書きます。書き方は `README.md` の「ワーカーの実行環境」に、決めた理由は `docs/design.md` の「製品のイメージのビルド」にあります。要点は次のとおりです。

- **ビルドするのは、起動係です。** ワーカー、verify、着手前の確認のどの実行でも、その前に、起動係が、内容から決まる名前のイメージが手元にあるかを見ます。なければ、ビルドしてから実行します。
- **使うのは、製品の既定ブランチの Dockerfile 1枚だけです。** 事務局が、同期のときに取得して保存します。作業用のブランチの内容と、製品のほかのファイルは使いません。
- **基本のイメージの名前は、ビルド引数 `FACTORY_BASE_IMAGE` で渡します。** 製品は、ファクトリーの手元の名前を知りません。
- **ビルドは、ワーカーと同じネットワークで動きます。** 外へ出られるのは、プロキシを通る443番のHTTPSだけです。資格情報は渡りません。時間の上限は30分です。
- **ワーカーのコンテナは、ルートが読み取り専用です。** 書けるのは、作業場所(`HOME` を含む)と `/tmp` だけです。実行時に入れるものを残さず、必要なものはイメージに入れます。

ビルドには、Docker の旧ビルダー(`DOCKER_BUILDKIT=0`)を使います。ビルドを、名前を指定したネットワークに置けるのが、旧ビルダーだけだからです。旧ビルダーは非推奨で、将来の Docker でなくなる可能性があります。

- **起動係は、起動のときに、旧ビルダーが使えるかを試します。** 使えなければ、ログに `launcher.builder_unavailable` を出します。起動係は止まらず、`worker.dockerfile` のない製品の実行は続きます。

  ```bash
  docker compose logs launcher | grep launcher.builder_unavailable
  ```

- **ホストの Docker を上げたら、このログを確かめます。** 出ていた場合、`worker.dockerfile` を書いた製品は、着手前の確認が通らなくなり、着手しません。当面は、製品の `factory.yml` から `worker.dockerfile` を外し、手でビルドしたイメージを設定の `worker_image` で指定します(下の「手でビルドする場合」)。

製品用のイメージと、その状態は、次で見られます。

```bash
docker image ls --filter label=factory.built="$(docker compose config --format json | jq -r .name)_factory-work"   # このファクトリーがビルドしたもの
docker image ls --filter label=factory.repo=owner/name                                                               # ある製品のもの
docker compose logs launcher | grep -e launcher.build_ -e launcher.image_                                            # ビルドと片付けの記録
pnpm run status                                                                                                      # ビルドに失敗した製品と、その理由
```

事務局は、着手の前に、製品の `commands.setup` がこのイメージで通ることを確かめます。ビルドに失敗した場合と、`setup` が通らない場合は、その製品には着手せず、理由を状況表示(`pnpm run status`)とログ(`preflight.failed`)に出します(`docs/design.md` の「着手前の確認」)。

#### 手でビルドする場合

`worker.dockerfile` を使わずに、手でビルドしたイメージを使うこともできます。付けた名前を、設定の製品の項目の `worker_image` に書きます。この場合、作り直しは自動では行われません。

```bash
git clone --depth 1 https://github.com/owner/name.git /tmp/owner-name
docker build -f /tmp/owner-name/.factory/worker.Dockerfile \
  --build-arg FACTORY_BASE_IMAGE=factory-worker \
  -t owner-name-worker /tmp/owner-name/.factory
```

### 作り直しの順

上から順に行います。下のものは、上のものに依存します。

1. 常駐用(`docker compose up -d --build`)。コンテナも入れ替わります。
2. ワーカーの基本(`docker compose build worker-image`)。
3. 製品用。`worker.dockerfile` を書いた製品は、起動係が次の実行の前に自動でビルドし直すので、何もしません。手でビルドしたもの(設定の `worker_image` で指定したもの)だけ、製品ごとに `docker build` します。

1は、2と3から独立しています。常駐用だけを作り直すとき、ワーカーのイメージを作り直す必要はありません。2を行ったら、手でビルドした製品用があれば、必ず3も行います。

ワーカーのイメージを作り直しても、常駐のコンテナを再起動する必要はありません。起動係は、ワーカーを立てるたびに、その時点のイメージを使います。実行中のステップは、始まったときのイメージのまま最後まで動きます。

## コンテナ

| コンテナ | 立てる者 | 寿命 | 持っているもの |
| --- | --- | --- | --- |
| `office` | Compose | 常駐(`restart: unless-stopped`) | GitHubのトークン、DB、作業場所 |
| `launcher` | Compose | 常駐 | Dockerソケット、Claudeのトークン。ネットワークにつながらない |
| `proxy` | Compose | 常駐 | なし |
| ワーカー(`factory-worker-<乱数>`) | 起動係 | ステップ1回 | その実行の作業場所だけ。Claudeを呼ぶステップでは、Claudeのトークン |

ワーカーのコンテナには、目印(`factory.worker=<作業場所のボリュームの名前>`)が付きます。起動係は、起動のときに、前回残ったものをこの目印で探して消します。

```bash
docker ps --filter label=factory.worker    # 実行中のワーカー
```

## ボリュームとネットワーク

名前の前には、Composeのプロジェクト名が付きます(例: `<プロジェクト>_factory-data`)。

| ボリューム | 中身 | 消すとどうなるか |
| --- | --- | --- |
| `factory-data` | DB、DBの複製、ワーカーのログ、製品のミラー | 実行の記録とログを失う。イシューの状態はGitHubから取り直せる |
| `factory-work` | イシューごとの作業場所 | 進行中の実行が続けられなくなる |
| `launcher-socket` | 事務局と起動係が通信するソケット | 再起動で作り直される |

| ネットワーク | つながるもの | 外への経路 |
| --- | --- | --- |
| `workers` | ワーカー、プロキシ | なし(`internal`) |
| `egress` | プロキシ | あり |
| `default` | 事務局 | あり(GitHubへの通信) |

## ホスト側に用意するもの

どれもGit管理外です。

| ファイル | 中身 | 読む者 |
| --- | --- | --- |
| `.env` | GitHubのトークン、`DOCKER_GID`(ホストの docker グループの番号) | 事務局(トークン)、Compose(`DOCKER_GID`) |
| `.env.launcher` | Claudeのトークン | 起動係だけ |
| `config/factory.config.yml` | 対象のリポジトリ、`worker_image` など | 事務局と起動係(読み取り専用でマウント) |

設定を変えたら、`docker compose restart office launcher` で読み直します。`worker_image` は起動係が読むので、起動係の再起動も要ります。`.env` には、ワーカーの基本を既定とは別の名前にするときだけ、`WORKER_IMAGE` も書きます(「ワーカーの基本の名前」)。

## イメージが古くないかを確かめる

作り直しを忘れても、ファクトリーは古いイメージのまま動き続けます。次の方法で確かめます。目印を付けて確かめられるようにする仕組みは #50 が扱います。

**常駐用が、手元のコードより古くないか。** イメージを作った時刻と、最後のコミットの時刻を比べます。イメージのほうが古ければ、作り直します。

```bash
docker compose images
docker image inspect "$(docker compose config --format json | jq -r .name)-office" --format '{{.Created}}'
git log -1 --format=%cI
```

時刻の表記(タイムゾーン)が違うことに注意します。文書だけのコミットの後なら、古くても作り直す必要はありません。

**手でビルドした製品用が、いまの基本を土台にしているか。** 起動係がビルドした製品用(`factory-built:<ハッシュ>`)は、名前が基本のイメージのIDから決まるので、確かめる必要はありません。手でビルドしたものは、基本のいちばん上の層が、製品用に含まれているかを見ます。`1` なら含まれていて、`0` なら基本を作り直した後に製品用を作り直していません。

```bash
top="$(docker image inspect factory-worker --format '{{range .RootFS.Layers}}{{println .}}{{end}}' | grep . | tail -1)"
docker image inspect owner-name-worker --format '{{range .RootFS.Layers}}{{println .}}{{end}}' | grep -c "$top"
```

**Claude Code の版が揃っているか。**

```bash
docker run --rm --entrypoint claude factory-worker --version
docker run --rm --entrypoint claude owner-name-worker --version
```

**設定にあるイメージが、手元にあるか。** 起動係が、起動のときに確かめています。何も出なければ、起動した時点ではすべてありました。

```bash
docker compose logs launcher | grep launcher.image_missing
```

起動の後に消したものは分からないので、いまの状態は次で見ます。

```bash
grep -n worker_image config/factory.config.yml
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -- '-worker'
```

## Claude Code の版を上げる

版は、`docker/worker.Dockerfile` の `CLAUDE_CODE_VERSION` で固定しています。フラグの挙動が、気づかないうちに変わらないようにするためです。上げるときは、イシューを立てて、次の順で行います。

1. `docker/worker.Dockerfile` の `CLAUDE_CODE_VERSION` を変える。
2. 確認用の環境で確かめる。どれも、稼働中のものとは別の名前で環境を立て、終わったら消します。
   - `scripts/check-isolation.sh`: 隔離が保たれている。
   - `scripts/check-worker.sh`: ワーカーの呼び出しが通る(実際にClaudeを呼ぶ)。
   - `scripts/check-prompts.sh`: 指示書が通る(実際にClaudeを呼ぶ。数分かかる)。
3. マージの後、稼働中の環境で、ワーカーの基本を作り直す(「作り直しの順」の2)。手でビルドした製品用があれば、それも作り直す(3)。起動係がビルドする製品用は、次の実行の前に自動で作り直される。

## 片付け

ディスクを使うのは、ビルドキャッシュ、古いイメージ、作業場所の3つです。安全な範囲だけを消すスクリプトは、#52 が扱います。それまでは、次の方法で手で行います。

```bash
docker system df    # 使用量を見る
```

- **ビルドキャッシュ:** `docker builder prune` で消せます。消しても動作には影響せず、次のビルドが遅くなるだけです。ただし、同じホストのほかの環境のキャッシュも消えます。
- **古いイメージ:** 作り直すと、前のイメージは名前のない状態で残ります。`docker image prune` で、名前のないイメージだけを消せます。製品のビルドが途中で失敗したときの層も、これで消えます。
- **起動係がビルドした製品用のイメージ:** ビルドし直したときに、起動係が、同じ製品の古いものを消します。設定から外した製品のものは残るので、ラベルで探して、名前を指定して消します。

  ```bash
  docker image ls --filter label=factory.repo=owner/name --format '{{.Repository}}:{{.Tag}}'
  docker image rm factory-built:<ハッシュ>
  ```
- **作業場所:** イシューがクローズされると、事務局が後片付けします。取り消した実行と、`failed` になったイシューの分は、まだ残ります(#36)。手で消す場合は、実行中のワーカーがいないことを確かめてからにします。

次のことは、行いません。

- **`docker system prune --volumes` や `docker volume prune` を使わない。** DBと作業場所のボリュームを消すおそれがあります。
- **`docker compose down -v` を使わない。** 同じ理由です。止めるだけなら `docker compose stop` を使います。
- **同じホストのほかの環境のもの(このプロジェクト名で始まらないコンテナ、イメージ、ボリューム)に触れない。** 名前を指定して消し、まとめて消すコマンドには頼りません。

## 確認用の環境

`scripts/check-isolation.sh` などの確認用のスクリプトは、稼働中のものとは別のプロジェクト名(既定: `factory-check` など)で、イメージ、コンテナ、ボリューム、ネットワークをひととおり作り、終わったら消します。ワーカーの基本も、別の名前(`<確認用の名前>-worker`)で作るので、稼働中の `factory-worker` は変わりません。

手で `docker compose` を試すときも、稼働中の環境に作用しないように、別の名前(`-p`)を付けます。実行の前に、`docker compose ps` で稼働の有無を確かめます。
