import { store } from "../../store";
import {
  dom,
  domById,
  domC,
  fnDomReplace,
  formatTime,
  message,
  myStorage,
} from "../../tools";
import { ID_BLOCK_LIST, initHTMLBlockedUsers } from "./create-html";
import { addBlockUser, removeBlockUser } from "./do-fetch";
import {
  BLACK_LIST_CONFIG_NAMES,
  BLOCKED_USER_LIST_TYPE,
  getAllBlockedUsers,
  IBlockedUser,
  IConfigBlackList,
  mergeBlockedUsers,
} from "./types";

/** 配置导出（可选择文件合并后导出） */
export const onExportBlack = async () => {
  const config = await myStorage.getConfig();
  const configBlackList: IConfigBlackList = {};
  BLACK_LIST_CONFIG_NAMES.forEach((name) => {
    if (typeof config[name] !== "undefined") {
      configBlackList[name] = config[name] as any;
    }
  });
  // 导出辅助函数
  const doExport = () => {
    const dateNumber = +new Date();
    const link = domC("a", {
      href:
        "data:text/csv;charset=utf-8,\ufeff" +
        encodeURIComponent(JSON.stringify(configBlackList)),
      download: `黑名单配置-${formatTime(dateNumber, "YYYYMMDD-HHmmss")}-${dateNumber}.txt`,
    });
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  // 创建文件选择框，让用户选择要合并的 txt 文件
  const fileInput = domC("input", {
    type: "file",
    accept: ".txt",
    style: "display: none;",
  }) as HTMLInputElement;
  document.body.appendChild(fileInput);
  fileInput.onchange = (e) => {
    const file = ((e.target as HTMLInputElement).files || [])[0];
    if (!file) {
      // 未选择文件，直接导出当前配置
      document.body.removeChild(fileInput);
      doExport();
      return;
    }
    // 读取选择的文件并合并黑名单内容
    const reader = new FileReader();
    reader.readAsText(file);
    reader.onload = (oFREvent) => {
      document.body.removeChild(fileInput);
      let fileContent = oFREvent.target ? oFREvent.target.result : "";
      if (typeof fileContent === "string") {
        // 移除 BOM 字符
        fileContent = fileContent.replace(/^\ufeff/, "").trim();
        try {
          const fileConfig = JSON.parse(fileContent) as IConfigBlackList;
          // 合并文件黑名单和当前黑名单
          configBlackList.blockedUsers = getAllBlockedUsers({
            blockedUsers: mergeBlockedUsers([
              ...(config.blockedUsers || []),
              ...(fileConfig.blockedUsers || []),
            ]),
            localBlockedUsers: mergeBlockedUsers([
              ...(config.localBlockedUsers || []),
              ...(fileConfig.localBlockedUsers || []),
            ]),
          });
          configBlackList.localBlockedUsers = [];
          // 合并标签
          if (fileConfig.blockedUsersTags) {
            configBlackList.blockedUsersTags = [
              ...new Set([
                ...(configBlackList.blockedUsersTags || []),
                ...fileConfig.blockedUsersTags,
              ]),
            ];
          }
          message("已合并选择的文件内容");
        } catch (err) {
          message("选择的文件内容格式错误，将导出当前配置");
        }
      }
      doExport();
    };
  };
  fileInput.click();
};

/** 配置导入并合并 */
export const onImportBlack = async (oFREvent: ProgressEvent<FileReader>) => {
  let configBlackJson = oFREvent.target ? oFREvent.target.result : "";
  if (typeof configBlackJson !== "string") return;
  // 移除 BOM 字符，否则 JSON.parse 会抛出 SyntaxError
  configBlackJson = configBlackJson.replace(/^\ufeff/, "").trim();
  let configBlack: IConfigBlackList;
  try {
    configBlack = JSON.parse(configBlackJson) as IConfigBlackList;
  } catch (e) {
    message("黑名单配置导入失败：文件内容格式错误");
    return;
  }
  const {
    blockedUsers = [],
    localBlockedUsers = [],
    blockedUsersTags = [],
  } = configBlack;
  const prevConfig = await myStorage.getConfig();
  const {
    blockedUsers: prevBlockUsers = [],
    localBlockedUsers: prevLocalBlockedUsers = [],
    blockedUsersTags: prevBlockedUsersTags = [],
  } = prevConfig;
  // 标签合并去重
  const nTags = [...new Set([...prevBlockedUsersTags, ...blockedUsersTags])];
  const nBlackList: IBlockedUser[] = mergeBlockedUsers([
    ...prevBlockUsers,
    ...blockedUsers,
  ]);
  const blockedUserIds = new Set(nBlackList.map((item) => item.id));
  const nLocalBlackList: IBlockedUser[] = mergeBlockedUsers([
    ...prevLocalBlockedUsers,
    ...localBlockedUsers,
  ]).filter((item) => !blockedUserIds.has(item.id));
  await myStorage.updateConfig({
    ...prevConfig,
    ...configBlack,
    blockedUsers: nBlackList,
    localBlockedUsers: nLocalBlackList,
    blockedUsersTags: nTags,
  });
  message("导入完成，正在同步黑名单...");
  onSyncBlackList(0, nBlackList, async (serverIds) => {
    // 同步完成后，从 txt 黑名单中排除服务器已有的用户，再推送至服务器
    const pushUsers = blockedUsers.filter(
      (u) => u.urlToken && !serverIds.has(u.id),
    );
    if (!pushUsers.length) return;
    message(`正在将 ${pushUsers.length} 名用户加入知乎黑名单...`);
    let successCount = 0;
    for (const user of pushUsers) {
      const result = await addBlockUser(user, { openTagChoose: false });
      if (result === BLOCKED_USER_LIST_TYPE.zhihu) successCount++;
      // 避免请求过于频繁触发限流
      await new Promise((r) => setTimeout(r, 200));
    }
    initHTMLBlockedUsers(document.body);
    if (successCount) message(`已将 ${successCount} 名用户加入知乎黑名单`);
  });
};

/** 清空黑名单列表 */
export const onSyncRemoveBlockedUsers = async () => {
  if (!confirm("您确定要取消所有知乎黑名单用户吗？")) return;
  if (!confirm("确定清空所有知乎黑名单用户？")) return;

  const { blockedUsers = [] } = await myStorage.getConfig();
  if (!blockedUsers.length) return;

  const buttonSync = dom('button[name="syncBlackRemove"]') as HTMLButtonElement;
  if (!buttonSync.querySelector("ctz-loading")) {
    fnDomReplace(buttonSync, {
      innerHTML: '<i class="ctz-loading">↻</i>',
      disabled: true,
    });
  }

  const len = blockedUsers.length;
  let finishNumber = 0;

  for (let i = 0; i < len; i++) {
    const info = blockedUsers[i];
    if (info.id) {
      removeBlockUser(info, false).then(async () => {
        finishNumber++;
        if (finishNumber === len) {
          fnDomReplace(buttonSync, {
            innerHTML: "清空知乎黑名单",
            disabled: false,
          });
          await myStorage.updateConfigItem("blockedUsers", []);
          initHTMLBlockedUsers(document.body);
        }
      });
    }
  }
};

/** 同步黑名单（同步完成后可选执行 onComplete，并传入服务器已有的黑名单用户 id 集合） */
export function onSyncBlackList(
  offset = 0,
  l: IBlockedUser[] = [],
  onComplete?: (serverIds: Set<string>) => void | Promise<void>,
  serverIds: Set<string> = new Set(),
) {
  const nodeList = domById(ID_BLOCK_LIST);
  if (!l.length && nodeList) {
    nodeList.innerHTML = "知乎黑名单加载中...";
  }

  const buttonSync = dom('button[name="syncBlack"]') as HTMLButtonElement;
  if (!buttonSync.querySelector("ctz-loading")) {
    fnDomReplace(buttonSync, {
      innerHTML: '<i class="ctz-loading">↻</i>',
      disabled: true,
    });
  }

  const limit = 20;
  const headers = store.getFetchHeaders();
  fetch(
    `https://www.zhihu.com/api/v3/settings/blocked_users?offset=${offset}&limit=${limit}`,
    {
      method: "GET",
      headers: new Headers(headers),
      credentials: "include",
    },
  )
    .then((response) => response.json())
    .then(async ({ data, paging }: { data: any[]; paging: any }) => {
      const prevConfig = await myStorage.getConfig();
      const { blockedUsers = [], localBlockedUsers = [] } = prevConfig;
      const prevBlockedUsers = [...blockedUsers, ...localBlockedUsers];

      data.forEach(({ id, name, url_token }) => {
        serverIds.add(id);
        const findItem = prevBlockedUsers.find((i) => i.id === id);
        l.push({
          id,
          name,
          urlToken: url_token,
          tags: (findItem && findItem.tags) || [],
        });
      });
      if (!paging.is_end) {
        onSyncBlackList(offset + limit, l, onComplete, serverIds);
        if (nodeList) {
          nodeList.innerHTML = `知乎黑名单加载中（${l.length} / ${paging.totals}）...`;
        }
      } else {
        const syncedIds = new Set(l.map((item) => item.id));
        await myStorage.updateConfig({
          ...prevConfig,
          blockedUsers: mergeBlockedUsers(l),
          localBlockedUsers: localBlockedUsers.filter(
            (item) => !syncedIds.has(item.id),
          ),
        });
        initHTMLBlockedUsers(document.body);
        fnDomReplace(buttonSync, {
          innerHTML: "同步知乎黑名单",
          disabled: false,
        });
        message("知乎黑名单同步完成");
        if (onComplete) await onComplete(serverIds);
      }
    });
}
