async function runProcessJobWithLegacyScenes({
  job,
  scenes,
  costumeCard,
  config,
  processScene,
  setSceneProgress
}) {
  const concurrency = 6;
  let index = 0;

  async function runNext() {
    if (index >= scenes.length) return;
    const i = index++;
    const scene = scenes[i];

    try {
      const result = await processScene(scene, costumeCard, config, job, i);
      setSceneProgress(job, i, scene.id, 'done', '完成 ✓', 4);
      job.results[i] = {
        sceneId: scene.id,
        sceneHeader: scene.header,
        sceneType: scene.sceneType,
        episode: scene.episode,
        content: result
      };
    } catch (err) {
      setSceneProgress(job, i, scene.id, 'error', `错误: ${err.message}`, 0);
      job.results[i] = {
        sceneId: scene.id,
        sceneHeader: scene.header,
        sceneType: scene.sceneType,
        episode: scene.episode,
        content: `[生成失败: ${err.message}]`
      };
    }

    job.completed++;
    await runNext();
  }

  const workers = Array(Math.min(concurrency, scenes.length)).fill(null).map(() => runNext());
  await Promise.all(workers);
  job.status = 'done';
  job.finishedAt = Date.now();
}

module.exports = { runProcessJobWithLegacyScenes };
