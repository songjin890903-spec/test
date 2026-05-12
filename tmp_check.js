  enrichLog(`[BatchEnrich] 函数被调用，segment=${segment?.id}，parsed存在=${!!parsed}，shots=${parsed?.shots?.length}，config存在=${!!config}，apiKey=${config?.apiKey ? '有' : '无'}`);
