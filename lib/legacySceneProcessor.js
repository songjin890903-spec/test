function createLegacySceneProcessor(deps) {
  const {
    buildSystemPrompt,
    loadCoreForPlan,
    extractDialogues,
    extractDirectorShots,
    SCENE_RULES,
    calcMinDuration,
    callAPI,
    buildPlanPrompt,
    parsePlan,
    forceInjectMissingDialogues,
    validatePlan,
    validatePlanSegmentSimilarity,
    validatePlanUniqueness,
    countBigMovement,
    SEG_CHECK_RE,
    buildSegmentPrompt,
    verifyDialogues,
    repairMissingDialogues,
    generateScenePlanBlock,
    filterBatchPrompts,
    deduplicateABlocks,
    extractDirectorKeywords,
    processDirectorNotes,
    WENXI_RULES,
    WUXI_RULES
  } = deps;

  function setSceneProgress(job, idx, sceneId, status, message, doneCount = 0) {
    const STEP_NAMES = ['规划', 'A参数', '写作', '验证'];
    const now = Date.now();
    if (!job.progress[idx]) {
      job.progress[idx] = { sceneId, status, message, steps: [] };
    }
    if (!job.progress[idx].steps || job.progress[idx].steps.length === 0) {
      job.progress[idx].steps = STEP_NAMES.map((name) => ({
        name,
        done: false,
        active: false,
        startTime: null,
        endTime: null
      }));
    }
    for (let i = 0; i < STEP_NAMES.length; i++) {
      const step = job.progress[idx].steps[i];
      if (i < doneCount) {
        step.done = true;
        step.active = false;
        if (!step.endTime) step.endTime = now;
      } else if (i === doneCount && status === 'processing') {
        step.done = false;
        step.active = true;
        if (!step.startTime) step.startTime = now;
      } else {
        step.done = false;
        step.active = false;
      }
    }
    job.progress[idx].sceneId = sceneId;
    job.progress[idx].status = message;
    job.progress[idx].message = message;
  }

  async function processSceneSingleShot(scene, costumeCard, config, job, sceneIndex, systemPrompt, dialogues) {
    job.progress[sceneIndex] = {
      sceneId: scene.id,
      status: 'processing',
      message: '生成中（单次模式，最长5分钟）...'
    };

    let userMsg = `请为以下场景生成完整的视频提示词。\n\n`;
    userMsg += `【场景信息】\n场景编号：${scene.id}\n场景地点：${scene.location || '见剧本'}\n`;
    userMsg += `出场角色：${scene.characters.join('、') || '见剧本'}\n`;
    userMsg += `⚠️ @声明必须填入实际内容：@${scene.characters.join(' @')} @${scene.location || '场景地点'}\n\n`;

    if (dialogues.length > 0) {
      userMsg += `⛔ 程序预算：本场台词最短时长（含台词的镜号时长必须≥对应值）\n`;
      userMsg += `  （语速规则：普通台词4字/秒；激动/急促/恐慌/颤音6字/秒；呻吟/喘息3字/秒；OS/VO独白2字/秒；逗号+0.4秒，句末。！？+0.7秒）\n`;
      dialogues.forEach((d, i) => {
        const min = calcMinDuration(d);
        userMsg += `[台词${i + 1}] ${d}  →  最短${min}秒\n`;
      });
      userMsg += `\n`;
    }

    userMsg += `⛔⛔⛔ 最优先铁律·防止指令泄漏（违反即整条输出作废）：\n`;
    userMsg += `以下所有规则是对你输出的【约束】，不是 C 部分的【内容】。\n`;
    userMsg += `禁止把任何规则文字、格式要求、元说明、"⚠️ XX 必须 YY"、"（⚠️ XX）"这类祈使句或括号元说明·写进最终输出里。\n`;
    userMsg += `C 部分只写画面叙事——摄影机运动 + 人物动作 + 台词 + （物理反馈）。\n`;
    userMsg += `不要在镜号之前或 C 部分开头加任何"格式声明"、"写法要求"、"规则说明"。\n`;
    userMsg += `不要用"（⚠️ ...）"或"（注：...）"或"（说明：...）"在 C 部分正文里出现。\n\n`;

    userMsg += `⛔ 强制执行规则（逐条执行，不得跳过）：\n`;
    userMsg += `1. C部分所有内容必须100%来自剧本原文，禁止自创任何动作、对话或场景。\n`;
    userMsg += `2. 剧本中▲开头的每一个动作必须在C部分对应镜号里出现，不得跳过或合并。\n`;
    userMsg += `3. 所有台词必须是剧本原文，一字不得改动，禁止自行创作台词。\n`;
    userMsg += `4. （导演讲戏：...）括号内优先级标注"必须补"或"⚠️必须"的内容，必须生成对应的独立镜号或片段。\n`;
    userMsg += `5. 如果导演讲戏里有Cold Open或特殊开场指令且标注"必须补"，必须作为第一个片段的前置镜号输出。\n`;
    userMsg += `6. 【镜头意图】稳帧点要求的每一帧，必须在对应镜号叙事里明确写出停帧时长。\n`;
    userMsg += `7. 【镜头意图】INSERT要求的特写画面，必须作为独立镜号出现在C部分，不得合并进其他镜号。\n`;
    userMsg += `8. 动笔写任何片段的C部分之前，必须先在analysis块【台词分配表】里逐条列出本片段所有台词和OS独白（包括原文），标注计划写入哪个镜号；写完后逐句回标"已在镜X使用"，有遗漏禁止输出。\n`;
    userMsg += `9. OS独白必须以"角色OS：引号原文"格式写进对应镜号叙事正文，不能只写画面描述而省略OS文字。\n`;
    userMsg += `9b. ⚠️ VO/画外音/旁白 台词严禁输出成独立的"（台词）：..."行——必须写成"角色VO/OS：台词原文（从听筒/画外传出）"的形式，融入某个镜号的叙事正文里。\n`;
    userMsg += `10. ⚠️ 每个片段镜号时长之和不得超过15秒。台词多/导演指令多时增加片段数量，不要硬塞。\n`;
    userMsg += `11. ⚠️ 台词之间必须有反应镜头（1-2秒）：角色A说完后，不要直接接角色B的台词。中间插一个听者反应的镜号。反应镜头也占时间，装不下就多分一个片段。\n`;
    userMsg += `12. 导演批注里描述的具体动作不能改——"漂移甩尾"不能改成"直冲"。\n`;
    userMsg += `13. ⚠️ 每片段字数预算（超1800字即梦会截断）：A≤200字·B≤200字·C≤1000字·D+E+F≤400字。\n`;
    userMsg += `14. A部分格式统一：所有片段的A部分用相同格式，不加方括号，参数用·分隔。\n`;
    userMsg += `15. 导演标注了⚠️/一定要/必须的内容，C部分叙事中必须明确体现（如"重音"→写"刻意加重咬字"）。\n`;
    userMsg += `16. 导演描述的连贯走位调度放在同一个片段，不拆开。\n`;
    userMsg += `17. ⚠️ 镜号格式铁律：每个镜号以 [景别] 开头·后接复合运镜指令·焦段写在镜号头部或描述里。${scene.sceneType === 'wuxi' ? '武戏用英文景别如 [大特写 (Extreme Close-up)]' : '文戏用中文景别如 [近景]·[中近景]·[过肩]'}。\n`;
    userMsg += `18. ⚠️ 三层缝合：第一层叙事+第二层摄影机运动（有情绪/力的理由）+第三层（）物理反馈，缺一不可。空壳镜号禁止输出。\n`;
    userMsg += `19. ⚠️ 禁止输出任何元注释、解释性文字、压缩说明、AI思考过程、操作说明。只输出提示词正文。\n`;
    userMsg += `20. ⚠️ 镜号内容唯一性：每个镜号的画面内容必须独特，禁止两个镜号描写完全相同的动作、状态或构图。相邻镜号必须有明确的视觉差异。\n`;
    userMsg += `21. ⚠️ 台词时长匹配：带台词（含OS/VO）的镜号，台词量必须与时长匹配。中文对白约3-5字/秒。2秒及以下的镜号，台词必须极简。\n`;

    if (scene.sceneType === 'wuxi') {
      userMsg += `\n【武戏专项规则】\n${WUXI_RULES}\n`;
    }

    if (scene.sceneType !== 'wuxi') {
      userMsg += `\n【文戏专项规则】\n`;
      userMsg += `⚠️ 以下规则来自 wenxi.txt 铁律，与结构指令配合使用。\n\n`;
      userMsg += `${WENXI_RULES}\n\n`;
      userMsg += `【文戏输出格式强制要求】（上述铁律必须通过以下格式体现）：\n`;
      userMsg += `文1. ⚠️ 台词三拍结构（重量台词必用）：情绪拐点句/决绝句/摊牌句必须写三拍——拍一组织动作（台词前·视线从A移到B）+ 拍二说台词（一句话内有2-3个视线落点）+ 拍三消化动作（台词后身体反应）。⛔ 禁止"张嘴念完就闭嘴"。\n`;
      userMsg += `文2. ⚠️ 台词顺序铁律：台词必须按剧本顺序逐字使用，禁止打乱顺序。\n`;
      userMsg += `文2-1. ⚠️ 严禁跨镜号偷台词：镜N只能使用本镜号应用的台词，禁止把后面镜号的台词提前写到前面镜号，也禁止把前面镜号的台词重复写到后面。\n`;
      userMsg += `文3. ⚠️ 听者身体反应：说话人说完立刻切走拍听者（上半身后靠/手停了/肩缩了），不是只拍脸。说话人不能连续占两个以上镜号。\n`;
      userMsg += `文4. ⚠️ 混合场景按文戏规则写——武戏动作当作"情绪驱动肢体"，镜头保持克制。\n`;
      userMsg += `文5. ⚠️ 镜号内容唯一性：每个镜号的画面内容必须独特，禁止两个镜号描写完全相同的动作、状态或构图。相邻镜号必须有明确的视觉差异（景别/角度/焦段/主体至少一项不同）。\n`;
      userMsg += `文6. ⚠️ 台词时长匹配：带台词（含OS/VO/声画分离）的镜号，台词量必须与时长匹配。中文对白经验值：3-5字/秒。台词较长时，必须改为声画分离（VO继续+画面切其他）或拆分到多个镜号。2秒及以下的镜号，台词描述必须极简（≤10字）。\n`;
    }

    if (scene.content.includes('转场') || scene.content.includes('无缝衔接')) {
      userMsg += `\n⚠️ 导演指定了转场方式，最后一个片段的最后一镜必须完成转场设计，不能截断。\n`;
    }
    userMsg += `\n`;

    const mustItemsSS = [];
    processDirectorNotes(scene.content, (match, inner) => {
      for (const line of inner.split('\n')) {
        if (line.includes('⚠️') || line.includes('一定要') || line.includes('必须')) {
          mustItemsSS.push(line.trim());
        }
      }
      return match;
    });
    if (mustItemsSS.length > 0) {
      userMsg += `【导演⚠️强调清单（写完后逐条检查是否落实）】\n`;
      mustItemsSS.forEach((item, i) => { userMsg += `[强调${i + 1}] ${item}\n`; });
      userMsg += `\n`;
    }

    userMsg += `═══ AGENT_A 批注剧本 ═══\n${scene.content}\n\n`;
    userMsg += `⚠️ 注意：剧本正文到此结束。以下【批注摘要】及所有 ═══ 分隔线是元数据（统计信息），不是剧本内容，不要处理、不要补写、不要输出，只输出到最后一个【片段11-1?】结束即可。\n\n`;
    if (costumeCard && costumeCard.trim()) {
      userMsg += `═══ AGENT_B 服化道卡 ═══\n${costumeCard}\n\n`;
    }
    userMsg += `\n⚠️ 禁止输出任何元注释、解释性文字、压缩说明、AI思考过程、操作说明。只输出提示词正文。\n`;
    userMsg += `请直接输出所有15秒片段的完整提示词，台词多时自动拆分，全部片段一次性输出。`;

    let result = await callAPI(systemPrompt, userMsg, config);

    if (dialogues.length > 0) {
      const missing = verifyDialogues(dialogues, result);
      if (missing.length > 0) {
        result = await repairMissingDialogues(missing, result, systemPrompt, config);
      }
      const finalMissing = verifyDialogues(dialogues, result);
      if (finalMissing.length > 0) {
        console.warn(`⚠️ ${scene.id} 单次模式台词总检：补写后仍有 ${finalMissing.length} 条遗漏：`);
        finalMissing.forEach((d, i) => console.warn(`   遗漏${i + 1}：${d.slice(0, 40)}...`));
      } else {
        console.log(`✓ ${scene.id} 单次模式台词总检通过，${dialogues.length} 条台词全部落实`);
      }
    }

    const segDurMatches = result.match(/【片段\S+】[\s\S]*?(?=【片段|$)/g) || [result];
    const SHOT_DUR_RE_SS = /镜\d+\s+(\d+(?:\.\d+)?)\s*s/g;
    for (let si = 0; si < segDurMatches.length; si++) {
      const segText = segDurMatches[si];
      const segTotal = Array.from(segText.matchAll(SHOT_DUR_RE_SS), (m) => parseFloat(m[1]))
        .reduce((sum, d) => sum + d, 0);
      if (segTotal > 15.5) {
        console.warn(`⚠️ ${scene.id} 单次模式片段${si + 1}：总时长 ${segTotal}s 超过15秒铁律上限`);
      } else if (segTotal > 0) {
        console.log(`✓ ${scene.id} 单次模式片段${si + 1}：时长 ${segTotal}s，合格`);
      }
    }

    const ssShotWarnings = [];
    const SHOT_DIALOGUE_RE_SS = /镜(\d+)\s+(\d+(?:\.\d+)?)\s*s[^·]*·[^·]*·dialogue:"([^"]+)"/g;
    let match;
    while ((match = SHOT_DIALOGUE_RE_SS.exec(result)) !== null) {
      const shotNum = match[1];
      const shotDur = parseFloat(match[2]);
      const dialogue = match[3];
      const minDur = calcMinDuration(dialogue);
      if (minDur > shotDur) {
        ssShotWarnings.push(`镜${shotNum}：台词"${dialogue.slice(0, 15)}..."需${minDur}秒，分配${shotDur}秒`);
      }
    }
    if (ssShotWarnings.length > 0) {
      console.warn(`⚠️ ${scene.id} 单次模式单镜号台词时长不足：`);
      ssShotWarnings.forEach((w) => console.warn(`   ${w}`));
    }

    const ssCharCount = result.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;
    console.log(`📊 ${scene.id} 单次模式字数统计：${ssCharCount}字 ${ssCharCount <= 1800 ? '✅' : '❌ 超标'}`);

    result = filterBatchPrompts(result);
    return result;
  }

  async function processSceneMultiStep(scene, costumeCard, config, job, sceneIndex) {
    const dialogues = extractDialogues(scene.content);
    const systemPrompt = buildSystemPrompt(scene.sceneType, {
      sceneContent: scene.content,
      dialogueCount: dialogues.length,
      characterCount: scene.characters.length,
      hasLongOS: /OS[：:]/.test(scene.content) && scene.content.length > 400
    });
    const planSystemPrompt = loadCoreForPlan();

    setSceneProgress(job, sceneIndex, scene.id, 'processing', '规划中...（最长5分钟，超时自动报错）', 0);

    let plan = null;
    const directorShots = extractDirectorShots(scene.content);
    const hasDirectorShots = directorShots.length > 0;
    const limits = hasDirectorShots
      ? { minShots: 5, maxShots: 10 }
      : (SCENE_RULES[scene.sceneType] || SCENE_RULES.mixed);

    let minSegments = 1;
    if (hasDirectorShots) {
      const shotCount = directorShots.filter((d) => d.isShot).length;
      const byTime = Math.ceil(shotCount * 2.5 / 15);
      const byChars = Math.ceil(directorShots.length / 8);
      const dialogueDur = dialogues.reduce((sum, d) => sum + calcMinDuration(d), 0);
      const byDialogue = dialogues.length > 0 ? Math.ceil(dialogueDur / 12) : 0;
      minSegments = Math.max(byTime, byChars, byDialogue, 1);
      console.log(`   导演讲戏模式：${shotCount}条镜头+${directorShots.length - shotCount}条内心·最少${minSegments}个片段（3-10镜/片段）`);
    }

    const planText1 = await callAPI(planSystemPrompt, buildPlanPrompt(scene, costumeCard, dialogues), config);
    let plan1 = parsePlan(planText1);
    if (plan1) plan1 = forceInjectMissingDialogues(plan1, dialogues);

    if (!plan1) {
      console.log(`⚠️ ${scene.id} 规划JSON解析失败`);
    } else {
      const errors1 = validatePlan(plan1, dialogues, limits, minSegments);
      const simErrors1 = validatePlanSegmentSimilarity(plan1);
      const allErrors1 = [...errors1, ...simErrors1];
      if (allErrors1.length === 0) {
        console.log(`✓ ${scene.id} 规划通过，共${plan1.segments.length}个片段`);
        plan = plan1;
      } else {
        console.log(`⚠️ ${scene.id} 规划有结构问题，修正中：\n${allErrors1.join('\n')}`);
        const fixPrompt = buildPlanPrompt(scene, costumeCard, dialogues)
          + `\n\n上次规划有以下结构错误，请修正后重新输出JSON：\n`
          + allErrors1.map((e) => `- ${e}`).join('\n');
        const planText2 = await callAPI(planSystemPrompt, fixPrompt, config);
        let plan2 = parsePlan(planText2);
        if (plan2) plan2 = forceInjectMissingDialogues(plan2, dialogues);

        if (!plan2) {
          console.log(`⚠️ ${scene.id} 修正规划JSON解析失败，使用plan1继续`);
          plan = plan1;
        } else {
          const errors2 = validatePlan(plan2, dialogues, limits, minSegments, true);
          const simErrors2 = validatePlanSegmentSimilarity(plan2);
          const allErrors2 = [...errors2, ...simErrors2];
          if (allErrors2.length === 0) {
            console.log(`✓ ${scene.id} 修正规划通过，共${plan2.segments.length}个片段`);
            plan = plan2;
          } else {
            console.log(`⚠️ ${scene.id} 两次规划均有结构问题，取较优规划继续：\n${allErrors2.join('\n')}`);
            plan = plan2.segments.length >= plan1.segments.length ? plan2 : plan1;
            console.log(`   → 使用 ${plan === plan2 ? 'plan2' : 'plan1'}（${plan.segments.length}个片段）`);
          }
        }
      }
    }

    if (plan) {
      const uniWarn = validatePlanUniqueness(plan, dialogues);
      if (uniWarn.length > 0) {
        console.warn(`⚠️ ${scene.id} 规划唯一性警告（不阻断）：`);
        uniWarn.forEach((w) => console.warn(`   ${w}`));
      }
    }

    if (!plan) {
      console.log(`⚠️ ${scene.id} 规划失败，降级为单次生成`);
      return processSceneSingleShot(scene, costumeCard, config, job, sceneIndex, systemPrompt, dialogues);
    }

    for (const seg of plan.segments) {
      const segText = (seg.shots || []).map((s) => `${s.task || ''} ${s.dialogue || ''}`).join(' ');
      const segMovementCount = countBigMovement(segText, SEG_CHECK_RE);
      const segDialogues = (seg.shots || []).map((s) => s.dialogue).filter(Boolean);
      const segRealDialogues = segDialogues.filter((d) => {
        const stripped = d.replace(/[""「」『』"'！？。，.,!?\s]/g, '');
        return stripped.length > 5;
      });
      const segDlCount = segRealDialogues.length;

      let inferredType;
      if (segDlCount >= 2) inferredType = 'wenxi';
      else if (segDlCount === 0 && segMovementCount >= 3) inferredType = 'wuxi';
      else if (segDlCount === 0 && segMovementCount >= 2) inferredType = 'wuxi';
      else inferredType = 'wenxi';

      seg.sceneType = scene.sceneType;
      if (inferredType !== scene.sceneType) {
        seg.sceneType = inferredType;
        console.log(`✨ ${scene.id} 片段${seg.id} 类型覆写：场景级 ${scene.sceneType} → 片段级 ${inferredType}（大运动${segMovementCount}个·真实台词${segDlCount}条）`);
        console.log(`   → 这个片段会按 ${inferredType} 规则写·允许大跨度镜头和 4s 大镜`);
      }
    }

    function extractASection(text) {
      const match = text.match(/【A】画面物理系统[：:]?\n?([\s\S]*?)(?=\n【B】)/);
      return match ? match[0].trim() : null;
    }

    let referenceA = null;
    if (costumeCard && costumeCard.trim()) {
      const fromB = costumeCard.match(/【画面物理系统】\n?([\s\S]*?)(?=\n【|$)/);
      if (fromB) {
        referenceA = '【A】画面物理系统：\n' + fromB[1].trim();
        console.log(`✓ ${scene.id} A部分来源：Agent B 服化道卡（${referenceA.length}字）`);
      }
    }

    let referenceAPromise = null;
    let referenceAResolve = null;
    if (!referenceA) {
      referenceAPromise = new Promise((resolve) => { referenceAResolve = resolve; });
      setSceneProgress(job, sceneIndex, scene.id, 'processing', '并行写作中...（最长5分钟，超时自动报错）', 1);
    }

    async function writeAndVerifySegment(seg, si, refA) {
      const prevTailFrame = si === 0 ? '' : (plan.segments[si - 1].tailFrame || '');
      const segPrompt = buildSegmentPrompt(
        scene, seg, costumeCard, prevTailFrame, si, plan.segments.length, refA, dialogues
      );

      const effectiveSystemPrompt = (seg.sceneType && seg.sceneType !== scene.sceneType)
        ? buildSystemPrompt(seg.sceneType, {
            sceneContent: scene.content,
            dialogueCount: dialogues.length,
            characterCount: scene.characters.length,
            hasLongOS: /OS[：:]/.test(scene.content) && scene.content.length > 400
          })
        : systemPrompt;

      let segOutput = await callAPI(effectiveSystemPrompt, segPrompt, config);

      const segDialogues = (seg.shots || []).map((s) => s.dialogue).filter(Boolean);
      if (segDialogues.length > 0) {
        const missing1 = verifyDialogues(segDialogues, segOutput);
        if (missing1.length > 0) {
          console.log(`⚠️ ${seg.id} 第1次补写：${missing1.length} 条遗漏`);
          let repaired = await repairMissingDialogues(missing1, segOutput, effectiveSystemPrompt, config);
          const missing2 = verifyDialogues(segDialogues, repaired);
          if (missing2.length > 0) {
            console.warn(`⚠️ ${seg.id} 补写后仍有 ${missing2.length} 条遗漏，强制注入...`);
            let injectNarr = '';
            missing2.forEach((d) => {
              const ci = d.indexOf('：');
              const charRaw = ci >= 0 ? d.substring(0, ci) : '';
              const charName = charRaw.replace(/[（(]?(?:VO|旁白|画外音|OS)[）)]?\s*/g, '').trim();
              const content = ci >= 0 ? d.substring(ci + 1).trim() : d;
              const isVO = /^(?:（VO）|（旁白）|（画外音）|\(?\s*(?:VO|OS)\s*\)?\s*)[：:]/.test(d);
              if (isVO) {
                if (charName) injectNarr += `画外音：${content}（${charName}OS）\n`;
                else injectNarr += `画外音：${content}\n`;
              } else if (charName) {
                injectNarr += `${charName}开口说："${content}"\n`;
              } else {
                injectNarr += `画外音："${content}"\n`;
              }
            });
            repaired = repaired.replace(/(?=【D】)/, `\n${injectNarr}\n`);
            console.warn(`⚠️ ${seg.id} 强制注入 ${missing2.length} 条台词叙事（不再调 API）`);
          } else {
            console.log(`✓ ${seg.id} 台词补写后核验通过`);
          }
          segOutput = repaired;
        } else {
          console.log(`✓ ${seg.id} 台词核验通过`);
        }
      }

      let charCount = segOutput.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;
      if (charCount > 1800) {
        console.warn(`⚠️ ${seg.id} 字数 ${charCount}·启动 Cascade 压缩...`);
        const afterCutF = segOutput.replace(/【F】必现目标[：:]?[^【]*?(?=\n【|$)/, '').trim();
        const c1 = afterCutF.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;

        if (c1 <= 1800) {
          segOutput = afterCutF;
          charCount = c1;
          console.log(`✓ ${seg.id} Cascade 级1·砍 F 后 ${c1} 字`);
        } else {
          const afterCutDF = afterCutF.replace(/【D】尾帧[：:]?[^【]*?(?=\n【|$)/, '').trim();
          const c2 = afterCutDF.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;

          if (c2 <= 1800) {
            segOutput = afterCutDF;
            charCount = c2;
            console.log(`✓ ${seg.id} Cascade 级2·砍 D+F 后 ${c2} 字`);
          } else {
            console.warn(`⚠️ ${seg.id} 级2 后仍 ${c2} 字·API 压缩 C...`);
            try {
              const compressPrompt =
                `以下片段字数 ${c2}·超 1800·请只压缩 C 部分的形容词和修辞·不得删除任何镜号、台词、（）物理反馈。D 和 F 已经被砍过·不用再碰。\n\n原片段：\n${afterCutDF}\n\n直接输出压缩后的完整片段。`;
              const compressed = await callAPI(effectiveSystemPrompt, compressPrompt, config);
              const c3 = compressed.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;
              if (c3 < c2 && c3 <= 2000) {
                segOutput = compressed;
                charCount = c3;
                console.log(`✓ ${seg.id} 级3·API 压缩后 ${c3} 字`);
              } else {
                segOutput = afterCutDF;
                charCount = c2;
                console.warn(`⚠️ ${seg.id} API 压缩无效·保留级2（${c2} 字）`);
              }
            } catch (err) {
              segOutput = afterCutDF;
              charCount = c2;
              console.warn(`⚠️ ${seg.id} API 压缩失败·保留级2: ${err.message}`);
            }
          }
        }
      } else {
        console.log(`✓ ${seg.id} 字数 ${charCount}·合格`);
      }

      const SHOT_DUR_RE = /镜\d+\s+(\d+(?:\.\d+)?)\s*s/g;
      const actualTotal = Array.from(segOutput.matchAll(SHOT_DUR_RE), (m) => parseFloat(m[1]))
        .reduce((sum, d) => sum + d, 0);
      const plannedTotal = (seg.shots || []).reduce((s, sh) => s + (sh.duration || 0), 0);
      if (actualTotal > 0 && actualTotal > 15.5) {
        console.warn(`⚠️ ${seg.id} 实际总时长 ${actualTotal}s 超过15秒铁律上限`);
      } else if (actualTotal > 0 && actualTotal > plannedTotal + 2) {
        console.warn(`⚠️ ${seg.id} 实际总时长 ${actualTotal}s 超过规划 ${plannedTotal}s（超${(actualTotal - plannedTotal).toFixed(1)}s）`);
      } else if (actualTotal > 0) {
        console.log(`✓ ${seg.id} 时长 ${actualTotal}s，合格`);
      }

      const SHOT_DIALOGUE_RE = /镜(\d+)\s+(\d+(?:\.\d+)?)\s*s[^·]*·[^·]*·dialogue:"([^"]+)"/g;
      const shotDurationWarnings = [];
      let match;
      while ((match = SHOT_DIALOGUE_RE.exec(segOutput)) !== null) {
        const shotNum = match[1];
        const shotDur = parseFloat(match[2]);
        const dialogue = match[3];
        const minDur = calcMinDuration(dialogue);
        if (minDur > shotDur) {
          shotDurationWarnings.push(`⚠️ ${seg.id} 镜${shotNum}：台词需≥${minDur}秒，分配${shotDur}秒，不足！`);
        }
      }
      if (shotDurationWarnings.length > 0) {
        console.warn(`⚠️ ${seg.id} 单镜号台词时长不足警告：`);
        shotDurationWarnings.forEach((w) => console.warn(`   ${w}`));
      }

      const segCharCount = segOutput.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim().length;
      console.log(`📊 ${seg.id} 字数统计：${segCharCount}字 ${segCharCount <= 1800 ? '✅' : '❌ 超标'}`);

      if (si === 0 && referenceAResolve) {
        const extractedA = extractASection(segOutput);
        if (extractedA) {
          referenceA = extractedA;
          console.log(`✓ ${scene.id} A部分从首片段提取（${referenceA.length}字）`);
        } else {
          console.warn(`⚠️ ${scene.id} 首片段未找到A部分，后续片段自行生成`);
        }
        referenceAResolve(referenceA);
        referenceAResolve = null;
      }

      segOutput = filterBatchPrompts(segOutput);
      return segOutput;
    }

    setSceneProgress(job, sceneIndex, scene.id, 'processing', `并行写作 ${plan.segments.length} 个片段...`, 2);

    async function writeWithRetry(seg, si, refA) {
      const MAX_RETRIES = 2;
      let lastErr = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          return await writeAndVerifySegment(seg, si, refA);
        } catch (err) {
          lastErr = err;
          const msg = err.message || '';
          const isRetryable = /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|fetch failed|socket hang up|600-second/i.test(msg);
          if (!isRetryable || attempt === MAX_RETRIES) {
            console.error(`❌ ${seg.id} 写作失败（尝试 ${attempt + 1}/${MAX_RETRIES + 1}）: ${msg}`);
            throw err;
          }
          const waitMs = 2000 * (attempt + 1);
          console.warn(`⚠️ ${seg.id} 网络/超时失败（尝试 ${attempt + 1}/${MAX_RETRIES + 1}），${waitMs / 1000}s 后重试: ${msg.slice(0, 80)}`);
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      throw lastErr;
    }

    const segmentPromises = plan.segments.map((seg, si) => {
      const getRefA = si === 0
        ? Promise.resolve(null)
        : (referenceAPromise || Promise.resolve(referenceA));
      return getRefA.then((resolvedA) =>
        writeWithRetry(seg, si, resolvedA !== null ? resolvedA : referenceA)
          .catch((err) => {
            if (si === 0 && referenceAResolve) {
              referenceAResolve(null);
              referenceAResolve = null;
            }
            console.error(`❌ ${seg.id} 最终失败: ${err.message}`);
            return `[${seg.id} 生成失败: ${err.message}]`;
          })
      );
    });
    const segResults = await Promise.allSettled(segmentPromises);
    let outputs = segResults.map((result, si) => {
      if (result.status === 'fulfilled') return result.value;
      return `[${plan.segments[si].id} 生成失败]`;
    });

    const scenePlanBlock = generateScenePlanBlock(plan, scene, dialogues);

    setSceneProgress(job, sceneIndex, scene.id, 'processing', '台词总检...', 3);
    if (dialogues.length > 0) {
      const finalMissing = verifyDialogues(dialogues, outputs.join('\n'));
      if (finalMissing.length > 0) {
        console.warn(`⚠️ ${scene.id} 全场景台词总检：${finalMissing.length} 条台词遗漏，智能定位补写...`);
        finalMissing.forEach((d, i) => console.warn(`   遗漏${i + 1}：${d.slice(0, 40)}...`));

        const dialogueSegMap = new Map();
        for (let segIdx = 0; segIdx < outputs.length; segIdx++) {
          if (outputs[segIdx].startsWith('[')) continue;
          for (const dlg of dialogues) {
            if (verifyDialogues([dlg], outputs[segIdx]).length === 0) {
              dialogueSegMap.set(dlg, segIdx);
            }
          }
        }

        const repairTasks = [];
        for (const missingDlg of finalMissing) {
          const mIdx = dialogues.indexOf(missingDlg);
          if (mIdx < 0) continue;

          let targetSegIdx = -1;
          for (let i = mIdx - 1; i >= 0; i--) {
            const prevD = dialogues[i];
            if (dialogueSegMap.has(prevD)) {
              targetSegIdx = dialogueSegMap.get(prevD);
              break;
            }
          }

          if (targetSegIdx < 0) {
            for (let i = mIdx + 1; i < dialogues.length; i++) {
              const nextD = dialogues[i];
              if (dialogueSegMap.has(nextD)) {
                targetSegIdx = dialogueSegMap.get(nextD);
                break;
              }
            }
          }

          if (targetSegIdx < 0) {
            targetSegIdx = outputs.length - 1;
            while (targetSegIdx >= 0 && outputs[targetSegIdx].startsWith('[')) targetSegIdx--;
          }

          if (targetSegIdx < 0) {
            console.warn(`⚠️ 台词 "${missingDlg.slice(0, 20)}..." 无法定位·跳过补写`);
            continue;
          }

          console.log(`   📍 台词 "${missingDlg.slice(0, 25)}..." 定位到片段 ${targetSegIdx + 1}/${outputs.length}`);
          repairTasks.push({ missingDlg, targetSegIdx });
        }

        const segRepairMap = new Map();
        for (const task of repairTasks) {
          if (!segRepairMap.has(task.targetSegIdx)) {
            segRepairMap.set(task.targetSegIdx, []);
          }
          segRepairMap.get(task.targetSegIdx).push(task.missingDlg);
        }

        const repairPromises = Array.from(segRepairMap.entries()).map(async ([segIdx, missingDlgs]) => {
          try {
            const newOutput = await repairMissingDialogues(missingDlgs, outputs[segIdx], systemPrompt, config);
            return { segIdx, newOutput, success: true };
          } catch (err) {
            console.warn(`⚠️ 片段 ${segIdx + 1} 补写失败：${err.message}`);
            return { segIdx, newOutput: outputs[segIdx], success: false };
          }
        });

        const repairResults = await Promise.all(repairPromises);
        for (const result of repairResults) {
          if (result.success) outputs[result.segIdx] = result.newOutput;
        }

        const finalMissing2 = verifyDialogues(dialogues, outputs.join('\n'));
        if (finalMissing2.length > 0) {
          console.warn(`⚠️ ${scene.id} 智能补写后仍有 ${finalMissing2.length} 条遗漏，兜底到末尾片段补写（第2次）...`);
          const lastIdx = outputs.findLastIndex((o, i) => !o.startsWith('[') && i === outputs.length - 1);
          const fallbackIdx = lastIdx >= 0 ? lastIdx : outputs.length - 1;
          if (fallbackIdx >= 0 && !outputs[fallbackIdx].startsWith('[')) {
            try {
              const repaired2 = await repairMissingDialogues(finalMissing2, outputs[fallbackIdx], systemPrompt, config);
              const finalMissing3 = verifyDialogues(dialogues, repaired2);
              if (finalMissing3.length > 0) {
                console.warn(`⚠️ ${scene.id} 兜底补写后仍有 ${finalMissing3.length} 条遗漏，不再补写，强制注入...`);
                const injectText = finalMissing3.map((d) => {
                  const ci = d.indexOf('：');
                  return ci >= 0 ? d : `（台词）：${d}`;
                }).join('\n');
                outputs[fallbackIdx] = repaired2.replace(/(?=【D】)/, `\n${injectText}\n`);
              } else {
                outputs[fallbackIdx] = repaired2;
                console.log(`✓ ${scene.id} 兜底补写后核验通过`);
              }
            } catch (err) {
              console.warn(`⚠️ 兜底补写失败：${err.message}`);
            }
          }
        } else {
          console.log(`✓ ${scene.id} 智能补写完成·${dialogues.length} 条台词全部落实`);
        }
      } else {
        console.log(`✓ ${scene.id} 全场景台词总检通过，${dialogues.length} 条台词全部落实`);
      }
    }

    const allShotsWarning = [];
    for (let segIdx = 0; segIdx < outputs.length; segIdx++) {
      const segText = outputs[segIdx];
      const segId = plan.segments[segIdx]?.id || `片段${segIdx + 1}`;
      const SHOT_DIALOGUE_RE_SCAN = /镜(\d+)\s+(\d+(?:\.\d+)?)\s*s[^·]*·[^·]*·dialogue:"([^"]+)"/g;
      let match;
      while ((match = SHOT_DIALOGUE_RE_SCAN.exec(segText)) !== null) {
        const shotNum = match[1];
        const shotDur = parseFloat(match[2]);
        const dialogue = match[3];
        const minDur = calcMinDuration(dialogue);
        if (minDur > shotDur) {
          allShotsWarning.push(`${segId} 镜${shotNum}：台词"${dialogue.slice(0, 15)}..."需${minDur}秒，分配${shotDur}秒（差${(minDur - shotDur).toFixed(1)}秒）`);
        }
      }
    }
    if (allShotsWarning.length > 0) {
      console.warn(`\n⚠️ ⚠️ ⚠️ ${scene.id} 全场景镜头时长不足汇总（共${allShotsWarning.length}处）：`);
      allShotsWarning.forEach((w) => console.warn(`   ${w}`));
      console.warn(`请调整该场景的片段分配或增加片段数量！\n`);
    } else {
      console.log(`✓ ${scene.id} 全场景镜头时长检测通过`);
    }

    outputs = deduplicateABlocks(outputs);

    let finalOutput = scenePlanBlock + '\n\n' + outputs.join('\n\n');
    finalOutput = filterBatchPrompts(finalOutput);

    const dirKeywords = extractDirectorKeywords(scene.content);
    if (dirKeywords.length > 0) {
      const allOutput = outputs.join('\n');
      const missingKw = dirKeywords.filter((kw) => !allOutput.includes(kw));
      if (missingKw.length > 0) {
        console.warn(`⚠️ ${scene.id} 导演指令核验：${missingKw.length} 个关键词未在输出中找到：${missingKw.join('、')}`);
      } else {
        console.log(`✓ ${scene.id} 导演指令核验通过，${dirKeywords.length} 个关键词全部落实`);
      }
    }

    return finalOutput;
  }

  return {
    setSceneProgress,
    processSceneMultiStep
  };
}

module.exports = { createLegacySceneProcessor };
