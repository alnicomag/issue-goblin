/**
 * リポジトリごとの排他。
 *
 * 同期と、事務局自身による状態の変更は、同じリポジトリについて同時に進めない。
 * 事務局は1つのプロセスなので、プロセスの中の順番待ちだけで足りる。
 */
export interface RepoLocks {
  /** `repo` について、先に待っている処理がすべて終わってから `task` を実行する。 */
  run<T>(repo: string, task: () => Promise<T>): Promise<T>;
}

export function createRepoLocks(): RepoLocks {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run(repo, task) {
      const previous = tails.get(repo) ?? Promise.resolve();
      // 先の処理が失敗しても、後の処理は進める。
      const next = previous.then(task, task);
      const tail = next.catch(() => {});
      tails.set(repo, tail);
      void tail.then(() => {
        if (tails.get(repo) === tail) tails.delete(repo);
      });
      return next;
    },
  };
}
