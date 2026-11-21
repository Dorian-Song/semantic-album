// 路漫漫其修远兮，吾将上下而求索。

/*
 * 文件夹浏览弹窗 (LegacyFolderBrowser)
 * 用法: window.LegacyFolderBrowser.open({ startPath, onSelect, onCancel })
 *   startPath  可选, 不传就从主目录开始
 *   onSelect   用户点 "Choose this folder" 时调用, 参数是绝对路径
 *   onCancel   用户点取消 / 右上角× / 按Esc 时调用
 * 数据来自后端 GET /api/imports/folders?path=...
 * 抄来的代码都在注释里标了出处, 详见同目录的 SOURCES.md
 */

// 外层的立即执行函数照搬自 Tangchunhai/modal 的 js/modal.js (2017):
// https://github.com/Tangchunhai/modal/blob/master/js/modal.js
// 包一层是为了不把里面的 const 变量漏到全局, 宿主页面里别的脚本也可能有叫 state / on 的变量
(function(window, undefined) {
    "use strict";

    const API_URL = '/api/imports/folders';

    // 弹窗当前的状态, 每次 open 时重置
    const state = {
        dialog: null,       // 第一次打开时才创建 <dialog>
        path: null,         // 当前显示的文件夹, 还没加载成功时是 null
        parent: null,       // 上一级, 到根目录时后端给 null
        home: null,
        onSelect: null,
        onCancel: null,
        finished: true,     // 防止 onSelect / onCancel 被调用两次 (取消按钮之后还会触发 close 事件)
    };

    // 请求计数, 思路来自下面 myfetch 那篇博客里控制 loading 的 count 变量:
    // 每发一次请求加一, 回来时对不上号说明用户已经点去别的文件夹了, 旧结果直接扔掉
    let requestCount = 0;


    /* ---------------------------------------------------------------
     * 1. 事件委托 on()
     * 抄自 AmraniCh/vanilla-filemanager 的 src/js/helpers.js (2020)
     * https://github.com/AmraniCh/vanilla-filemanager/blob/master/src/js/helpers.js
     * 原版:
     *   function on(event, selector, handler) {
     *       document.addEventListener(event, function (e) {
     *           if (e.target.matches(selector)) { handler(e); }
     *           var parent = e.target.parentElement;
     *           while (parent !== null) {
     *               if (parent.matches(selector)) { handler(e); }
     *               parent = parent.parentElement;
     *           }
     *       });
     *   }
     * 改动: 1) 原版挂在 document 上, 这里多了一个 root 参数, 只挂在我们自己的 dialog 上, 不影响宿主页面
     *       2) 原版 target 和父元素都命中时 handler 会被调两次, 这里找到第一个就 return
     *       3) 原版只把 e 传给 handler, 这里顺便把命中的元素也传过去, 省得再 closest 一次
     * --------------------------------------------------------------- */
    const on = (root, event, selector, handler) => {
        root.addEventListener(event, (e) => {
            let node = e.target;
            while (node !== null && node !== root) {    // 只往上找到 root 为止
                if (node.matches(selector)) {
                    handler(e, node);
                    return;
                }
                node = node.parentElement;
            }
        });
    };


    /* ---------------------------------------------------------------
     * 2. 请求封装 myfetch()
     * 改写自 博客园 whosmeya《基于 Fetch 的请求封装》(2020)
     * https://www.cnblogs.com/whosmeya/p/13211221.html
     * 保留: "返回的 Promise 一定 resolve, 固定格式 { code, data, message }", 调用的地方不用每次写 catch
     * 去掉: TypeScript 类型、antd 的 message.error 弹提示、redux 的 loading、给 url 拼域名 (我们是同源请求)
     * 改动: 原版遇到非 2xx 直接返回空的结果, 不读 body; 但我们的后端把出错原因放在 body 的 error 里
     *       (400 / 403 folder_not_readable / 404 folder_not_found), 所以不管状态码都先把 json 读出来
     *       原版的类叫 Response, 会把浏览器自带的 window.Response 盖掉, 改名叫 Result
     * --------------------------------------------------------------- */
    class Result {
        constructor(code, data, message) {
            this.code = code;       // 0 表示成功, 否则是后端的错误码或者 HTTP 状态码
            this.data = data;
            this.message = message;
        }
    }

    const myfetch = (input) => {
        return fetch(input, {
            headers: {
                'Accept': 'application/json',
            },
        })
            .then((resp) => {
                return resp
                    .json()
                    .then((json) => {
                        // code 不为 2xx: 后端的 { error: { code, message } } 里有能给用户看的原因
                        if (!resp.ok) {
                            const error = (json && json.error) || {};
                            return new Result(error.code || resp.status, null, error.message || ('Request failed (HTTP ' + resp.status + ').'));
                        }
                        // 请求成功的数据
                        return new Result(0, json, null);
                    })
                    .catch((err) => {
                        // 不是 json 格式, 比如后端没启动时开发服务器代理返回的错误页
                        return new Result(999998, null, 'The server answered with something that is not JSON (HTTP ' + resp.status + ').');
                    });
            })
            .catch((err) => {
                // 请求发送失败
                return new Result(999999, null, 'Could not reach the server. Check that the Album backend is running.');
            });
    };


    /* ---------------------------------------------------------------
     * 3. 面包屑 generateCrumbsFromPath()
     * 改写自 GitHub gist adrielTosi "Make path into crumbs" (2021),
     * gist 自己注明是从 intesso/url-breadcrumb 的 index.js 改来的
     * https://gist.github.com/adrielTosi/cddcfbbf820ab3f46914d1b31d6268c4
     * 原版处理的是网址, 这里处理的是磁盘上的绝对路径, 所以删了几处:
     *   - opts 参数 (home 名字、endingSlash、beautify) 都不要了
     *   - 原版先 split(/[?#]/) 去掉查询串和锚点; 文件夹名里真的可能有 # 或 ?, 删了
     *   - 原版对每一段 decodeURIComponent; 文件夹名不是网址编码过的, 名字里带 % 会直接抛 URIError, 删了
     *   - 原版的 beautify 会把 - _ 换成空格并首字母大写, 文件夹名必须原样显示, 删了
     * 只支持 / 分隔的路径 (Linux / macOS), Windows 的 C:\ 路径没有处理
     * --------------------------------------------------------------- */
    const generateCrumbsFromPath = (path) => {
        // split segments by slash and filter empty elements
        const segments = path.split("/").filter(Boolean);
        // add first element for root element
        segments.unshift("");

        // enhance segments array
        return segments.map((crumb, i, arr) => {
            // join the segments array up to the actual element with slash
            let p = arr.slice(0, i + 1).join("/");
            // the first element must always be a slash
            if (i === 0) p = "/";
            return {
                name: i === 0 ? "/" : crumb,
                link: arr.length - 1 === i ? null : p,  // 最后一段就是当前文件夹, 不需要能点
            };
        });
    };


    /* ---------------------------------------------------------------
     * 4. 文件夹列表的一行 creatElem_Folder()
     * 改写自 博客园 wangjunxiang《前端小练习(一) 实现网页端的文件资源管理器》(2023)
     * https://www.cnblogs.com/wangjunxiang/p/17237008.html
     * 原版: 外层 div + 下拉箭头 + Font Awesome 文件夹图标 + 名字 div, 然后递归读取子文件夹, 拼成一棵树
     * 改动: - 我们每次只显示一层, 去掉了下拉箭头、childen_Area 子区域和递归调用 processHandle
     *       - 原版的 root 是 File System Access API 的句柄, 这里换成后端给的 { name, path }
     *       - 没有引 Font Awesome, 图标改成 CSS 画的小方块 (见 Architect.css 的 .folder_ICON)
     *       - 外层 div 换成 button, 这样 Tab 键能选中、回车能打开
     *       - 原版在这里绑 onclick, 我们用上面的 on() 统一委托, 列表重画时不用重新绑事件
     *       - 原版里一堆 style.marginLeft 挪到了 Responsive.css
     * 变量名保留原版的拼写 (facting_Folder / creatElem)
     * --------------------------------------------------------------- */
    function creatElem_Folder(root, Elem) {
        // 这是创建外面包裹的边框
        let facting_Folder = document.createElement("button");
        facting_Folder.type = "button";
        facting_Folder.className = "folder";
        facting_Folder.dataset.path = root.path;
        facting_Folder.title = root.path;   // 鼠标停留时能看到完整路径

        // 创建文件夹图标
        let folder_ICON = document.createElement("span");
        folder_ICON.className = "folder_ICON";

        // 创建文件夹名字显示区域
        let folder_Name = document.createElement("span");
        folder_Name.className = "folder_Name";
        folder_Name.append(root.name);  // 用 append 文字而不是 innerHTML, 名字里有 < > 也不会被当成标签

        facting_Folder.appendChild(folder_ICON);
        facting_Folder.appendChild(folder_Name);
        Elem.appendChild(facting_Folder);
    }


    /* ---------------------------------------------------------------
     * 5. 下面是自己写的胶水代码: 建弹窗、加载、渲染、关闭
     * --------------------------------------------------------------- */

    // 弹窗的骨架. 分成 header / content / foot 三块和 data-close="modal" 关闭属性,
    // 都是照 Tangchunhai/modal 的 modal.html 的结构来的;
    // 但原版是 "遮罩 div + 定位 div", 宿主页面已经用 showModal() 打开了一个 <dialog> 时,
    // 普通 div 不在顶层 (top layer), 会被盖在下面而且点不动, 所以外壳换成了原生 <dialog>
    const TEMPLATE = `
        <div class="folder-browser-header">
            <h1 class="folder-browser-title">Choose a folder to import</h1>
            <button type="button" class="folder-browser-close" data-close="modal" aria-label="Close">&times;</button>
        </div>
        <div class="folder-browser-content">
            <div class="folder-browser-toolbar">
                <button type="button" class="folder-browser-btn" data-action="up">&uarr; Up one level</button>
                <button type="button" class="folder-browser-btn" data-action="home">&#8962; Home</button>
            </div>
            <nav class="folder-browser-crumbs" aria-label="Current folder"></nav>
            <p class="folder-browser-status hidden" role="status"></p>
            <div class="folder-browser-list" aria-label="Subfolders"></div>
            <p class="folder-browser-count"></p>
            <p class="folder-browser-note">
                Supported types: JPEG, PNG, WebP, GIF, BMP, TIFF, HEIC/HEIF and AVIF, recognised by their content
                rather than the file name. Other files are skipped. Subfolders are included in the import.
            </p>
        </div>
        <div class="folder-browser-foot">
            <button type="button" class="folder-browser-btn" data-close="modal">Cancel</button>
            <button type="button" class="folder-browser-btn folder-browser-btn-primary" data-action="choose">Choose this folder</button>
        </div>
    `;

    // 方便取弹窗里的元素
    const $ = (selector) => state.dialog.querySelector(selector);

    const createDialog = () => {
        const dialog = document.createElement('dialog');
        dialog.className = 'folder-browser';
        dialog.setAttribute('aria-label', 'Choose a folder to import');
        dialog.innerHTML = TEMPLATE;
        document.body.appendChild(dialog);

        // 取消: 底部 Cancel 按钮和右上角 × 都带 data-close="modal" (Tangchunhai/modal 的写法)
        on(dialog, 'click', '[data-close="modal"]', () => finish(null));

        // 点文件夹 -> 进入这个文件夹
        on(dialog, 'click', '.folder', (e, node) => loadFolder(node.dataset.path));

        // 点面包屑 -> 跳到那一级
        on(dialog, 'click', '.crumb-link', (e, node) => loadFolder(node.dataset.path));

        on(dialog, 'click', '[data-action="up"]', () => {
            if (state.parent) loadFolder(state.parent);
        });
        on(dialog, 'click', '[data-action="home"]', () => {
            // home 还不知道 (比如第一次就加载失败了) 时不带 path, 后端默认就是主目录
            loadFolder(state.home);
        });
        on(dialog, 'click', '[data-action="choose"]', () => {
            if (state.path) finish(state.path);
        });

        // 按 Esc 时浏览器会先在 dialog 上触发 cancel 事件, 写法照 MDN 的例子:
        // https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/cancel_event
        // 两层 dialog 叠着的时候, 浏览器只把 cancel 发给最上面那个, 所以按一次 Esc 只关我们这一层
        dialog.addEventListener('cancel', (event) => {
            event.preventDefault();     // 拦下浏览器自己的关闭, 统一走 finish, 保证 onCancel 只调一次
            finish(null);
        });
        // 兜底: 有时 cancel 不可取消 (Chrome 防止网页一直拦着 Esc), 浏览器会直接关掉弹窗
        dialog.addEventListener('close', () => {
            if (!state.finished) finish(null);
        });

        return dialog;
    };

    // 状态栏: type 是 'loading' / 'error' / '' (清空)
    const showStatus = (type, text) => {
        const status = $('.folder-browser-status');
        status.textContent = text || '';
        status.classList.toggle('loading', type === 'loading');
        status.classList.toggle('error', type === 'error');
        status.classList.toggle('hidden', !type);  // 没有消息时整行隐藏, 不占位置
    };

    // 加载中时禁止 "选择", 不然用户可能选中的是还没刷新的旧文件夹
    const setBusy = (busy) => {
        $('.folder-browser-list').setAttribute('aria-busy', busy ? 'true' : 'false');
        $('[data-action="choose"]').disabled = busy || !state.path;
        $('[data-action="up"]').disabled = busy || !state.parent;
    };

    const renderCrumbs = (path) => {
        const nav = $('.folder-browser-crumbs');
        nav.innerHTML = '';
        nav.title = path;
        generateCrumbsFromPath(path).forEach((crumb, i) => {
            if (i > 1) {
                // 根目录 "/" 自己就是分隔符, 从第二段往后才加 ›
                const sep = document.createElement('span');
                sep.className = 'crumb-sep';
                sep.textContent = '›';
                nav.appendChild(sep);
            }
            const item = document.createElement(crumb.link ? 'button' : 'span');
            item.textContent = crumb.name;
            if (crumb.link) {
                item.type = 'button';
                item.className = 'crumb-link';
                item.dataset.path = crumb.link;
            } else {
                item.className = 'crumb-current';
            }
            nav.appendChild(item);
        });
    };

    const renderCount = (n) => {
        const count = $('.folder-browser-count');
        if (n === 0) {
            count.textContent = 'No supported images directly in this folder (images in subfolders are still imported).';
        } else {
            count.textContent = n + (n === 1 ? ' supported image' : ' supported images') + ' directly in this folder (subfolders not counted).';
        }
        count.classList.toggle('empty', n === 0);
    };

    const render = (data) => {
        state.path = data.path;
        state.parent = data.parent;
        state.home = data.home;

        renderCrumbs(data.path);

        const list = $('.folder-browser-list');
        list.innerHTML = '';
        if (data.folders.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'folder-browser-empty';
            empty.textContent = 'No subfolders here.';
            list.appendChild(empty);
        }
        data.folders.forEach((folder) => creatElem_Folder(folder, list));
        list.scrollTop = 0;     // 换了文件夹要回到列表顶部, 不然会停在上一个文件夹滚到的位置

        renderCount(data.imageFiles);
    };

    const loadFolder = (path) => {
        const myRequest = ++requestCount;
        showStatus('loading', 'Loading folder…');
        setBusy(true);

        // 文件夹名可能有中文、空格、& 之类, 必须 encodeURIComponent, 不然 & 后面会被当成另一个参数
        const url = path ? API_URL + '?path=' + encodeURIComponent(path) : API_URL;

        myfetch(url).then((res) => {
            if (myRequest !== requestCount) return;     // 用户已经点了别的文件夹 (或者关掉了弹窗), 这个结果不要了
            if (res.code !== 0) {
                // 出错时当前文件夹和列表保持原样, 用户可以点上一级 / Home / 面包屑回去
                // 第一次就失败时面包屑是空的, 所以把打不开的路径也写进提示里
                showStatus('error', res.message + (path ? ': ' + path : ''));
                setBusy(false);
                return;
            }
            render(res.data);
            showStatus('', '');
            setBusy(false);
        });
    };

    // 关闭弹窗, chosenPath 为 null 表示取消
    const finish = (chosenPath) => {
        if (state.finished) return;
        state.finished = true;
        requestCount++;     // 还没回来的请求作废

        if (state.dialog.open) state.dialog.close();

        const callback = chosenPath === null ? state.onCancel : state.onSelect;
        state.onSelect = null;
        state.onCancel = null;
        if (typeof callback === 'function') {
            if (chosenPath === null) {
                callback();
            } else {
                callback(chosenPath);
            }
        }
    };

    const open = (options) => {
        options = options || {};

        // 第一次用时才创建; 宿主页面如果把 body 清空重画了, 也要重新建一个
        if (!state.dialog || !document.body.contains(state.dialog)) {
            state.dialog = createDialog();
        }
        // 已经开着的话, 先按取消处理上一次的调用
        if (!state.finished) finish(null);

        state.finished = false;
        state.onSelect = options.onSelect || null;
        state.onCancel = options.onCancel || null;
        state.path = null;
        state.parent = null;
        state.home = null;
        $('.folder-browser-crumbs').innerHTML = '';
        $('.folder-browser-list').innerHTML = '';
        $('.folder-browser-count').textContent = '';

        // showModal 会把 dialog 放进顶层, 后打开的在最上面, 所以就算宿主页面已经开着一个模态 dialog 也能点
        if (!state.dialog.open) state.dialog.showModal();

        loadFolder(options.startPath || null);
    };

    window.LegacyFolderBrowser = {
        open: open,
        close: () => finish(null),
    };
})(window);
