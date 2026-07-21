// PhotoKit 导入 Agent (frida-objc-bridge 版)
//
// 调试策略：先把每一步都 console.log 出来，确认哪一行崩。

'use strict';

import ObjC from 'frida-objc-bridge';

function logStep(tag, msg) {
    send({ type: 'log', domain: 'photos_agent', tag: tag, msg: msg });
}

function ensurePhotosFramework() {
    const diag = { alreadyLoaded: false, triedLoad: false, loadError: null };
    try {
        if (ObjC.classes.PHPhotoLibrary && ObjC.classes.PHAssetCreationRequest) {
            diag.alreadyLoaded = true;
            return { ok: true, diag: diag };
        }
        diag.triedLoad = true;
        try {
            Module.load('/System/Library/Frameworks/Photos.framework/Photos');
        } catch (e) {
            diag.loadError = String(e);
        }
        if (!ObjC.classes.PHPhotoLibrary || !ObjC.classes.PHAssetCreationRequest) {
            return { ok: false, diag: diag, error: 'classes still missing after load' };
        }
        return { ok: true, diag: diag };
    } catch (e) {
        return { ok: false, diag: diag, error: String(e) };
    }
}

function fileExistsOnDevice(path) {
    try {
        const fm = ObjC.classes.NSFileManager.defaultManager();
        return !!fm.fileExistsAtPath_(path);
    } catch (e) {
        return false;
    }
}

// 把文件拷贝到当前进程的 NSTemporaryDirectory()。返回 {ok, path/error}。
// 走 NSData.dataWithContentsOfFile + writeToFile 路径，不依赖 NSFileManager 的特定方法。
function copyIntoHostTmp(srcPath) {
    try {
        // 取 NSTemporaryDirectory()
        const NSTemporaryDirectory = new NativeFunction(
            Module.getGlobalExportByName('NSTemporaryDirectory'),
            'pointer', []
        );
        const tmpNS = new ObjC.Object(NSTemporaryDirectory());
        const tmp = tmpNS.toString();
        logStep('copy', 'host tmp dir = ' + tmp);

        const ts = Date.now();
        const base = srcPath.split('/').pop();
        const dst = tmp + (tmp.endsWith('/') ? '' : '/') + 'photos_import_' + ts + '_' + base;
        logStep('copy', 'dst = ' + dst);

        const NSData = ObjC.classes.NSData;
        const data = NSData.dataWithContentsOfFile_(srcPath);
        if (data === null) {
            logStep('copy', 'dataWithContentsOfFile returned null — read FAILED (sandbox?)');
            return { ok: false, error: 'NSData.dataWithContentsOfFile returned null (read sandbox denied?)' };
        }
        const len = +data.length();
        logStep('copy', 'read ' + len + ' bytes from src');

        const wrote = data.writeToFile_atomically_(dst, true);
        if (!wrote) {
            logStep('copy', 'writeToFile FAILED at ' + dst);
            return { ok: false, error: 'writeToFile returned NO' };
        }
        logStep('copy', 'wrote OK to ' + dst);
        return { ok: true, path: dst, size: len };
    } catch (e) {
        return { ok: false, error: String(e), stack: e.stack };
    }
}

// 找一个已存在的 PHPhotoLibrary 实例（Photos.app 自己创建的）。
// 直接调 +sharedPhotoLibrary 会在 Frida 线程触发懒初始化，
// 在 Photos.app 里可能踩到 dispatch_once 的非主线程断言导致进程崩。
function findExistingLibrary() {
    try {
        const PHPhotoLibrary = ObjC.classes.PHPhotoLibrary;
        const instances = ObjC.chooseSync({ class: PHPhotoLibrary });
        logStep('lib', 'PHPhotoLibrary live instances: ' + instances.length);
        if (instances.length > 0) {
            return instances[0];
        }
        return null;
    } catch (e) {
        logStep('lib', 'chooseSync failed: ' + String(e));
        return null;
    }
}

// 探针：只验证 NSURL + PHAssetCreationRequest 类可达，不做 performChanges
function probeUrlAndClass(filePath) {
    try {
        const fwOk = ensurePhotosFramework();
        if (!fwOk.ok) return { ok: false, step: 'ensure', error: fwOk.error, diag: fwOk.diag };
        logStep('probe', 'classes ok');

        const NSURL = ObjC.classes.NSURL;
        const url = NSURL.fileURLWithPath_(filePath);
        if (url === null) return { ok: false, step: 'fileURLWithPath', error: 'returned null' };
        logStep('probe', 'url ok: ' + url.toString());

        const exists = fileExistsOnDevice(filePath);
        logStep('probe', 'file exists: ' + exists);

        const library = findExistingLibrary();
        if (library === null) {
            return { ok: false, step: 'findExistingLibrary', error: 'no PHPhotoLibrary instance found in this process' };
        }
        logStep('probe', 'library (existing): ' + library.toString());

        return {
            ok: true,
            url: url.toString(),
            fileExists: exists,
            library: library.toString(),
        };
    } catch (e) {
        return { ok: false, error: String(e), stack: e.stack };
    }
}

function importAsset(filePath, isVideo) {
    return new Promise(function (resolve) {
        let resolved = false;
        const safeResolve = (r) => { if (!resolved) { resolved = true; resolve(r); } };

        // 超时兜底：60s 内 completion 没触发，强行返回
        const timeoutId = setTimeout(() => {
            logStep('import', '60s TIMEOUT, force resolve');
            safeResolve({ ok: false, error: 'timeout after 60s', state: state });
        }, 60000);

        const state = {
            localId: null,
            requestCreated: false,
            innerError: null,
            preExisted: false,
        };

        try {
            const fwOk = ensurePhotosFramework();
            if (!fwOk.ok) {
                clearTimeout(timeoutId);
                safeResolve({ ok: false, error: fwOk.error, diag: fwOk.diag });
                return;
            }
            logStep('import', 'A: framework ensured');

            if (!fileExistsOnDevice(filePath)) {
                clearTimeout(timeoutId);
                safeResolve({ ok: false, error: 'file not found on device', path: filePath });
                return;
            }
            logStep('import', 'B: file exists on device: ' + filePath);

            // 把文件先复制进 Photos.app 沙盒 tmp 目录，绕开 sandbox 读权限
            const cp = copyIntoHostTmp(filePath);
            if (!cp.ok) {
                clearTimeout(timeoutId);
                safeResolve({ ok: false, error: 'copy into host tmp failed: ' + cp.error });
                return;
            }
            const importPath = cp.path;
            state.tmpPath = importPath;
            logStep('import', 'B+: using sandbox tmp path: ' + importPath);

            const PHAssetCreationRequest = ObjC.classes.PHAssetCreationRequest;
            const NSURL = ObjC.classes.NSURL;

            const url = NSURL.fileURLWithPath_(importPath);
            logStep('import', 'C: url = ' + url);

            const library = findExistingLibrary();
            if (library === null) {
                clearTimeout(timeoutId);
                safeResolve({ ok: false, error: 'no PHPhotoLibrary instance in process; spawn host but it has not lazily inited yet' });
                return;
            }
            logStep('import', 'D: library = ' + library);

            // changes 块（void(^)(void)）
            // 用 PHAssetResourceCreationOptions + addResourceWithType: 路径，
            // 比 creationRequestForAssetFromVideoAtFileURL: 更可控。
            //   * PHAssetResourceTypeVideo  = 1
            //   * PHAssetResourceTypePhoto  = 4 (实际为 0... 见下面 isVideo 分支)
            //   * shouldMoveFile=YES        让 PhotoKit 取走文件，绕开沙盒读权限问题
            //
            // 苹果常量（PhotoKit）:
            //   PHAssetResourceTypePhoto       = 1
            //   PHAssetResourceTypeVideo       = 2
            //   PHAssetResourceTypeAudio       = 3
            //   PHAssetResourceTypeAlternatePhoto = 4
            //   PHAssetResourceTypeFullSizePhoto  = 5
            //   PHAssetResourceTypeFullSizeVideo  = 6
            const resourceType = isVideo ? 2 : 1;
            const changesBlock = new ObjC.Block({
                retType: 'void',
                argTypes: [],
                implementation: function () {
                    try {
                        logStep('changes', 'block entered');
                        let req = null;
                        if (isVideo) {
                            req = PHAssetCreationRequest.creationRequestForAsset();
                        } else if (typeof PHAssetCreationRequest.creationRequestForAssetFromImageAtFileURL_ === 'function') {
                            req = PHAssetCreationRequest.creationRequestForAssetFromImageAtFileURL_(url);
                        } else {
                            req = PHAssetCreationRequest.creationRequestForAsset();
                        }
                        if (req === null) {
                            state.innerError = 'creationRequestForAsset returned null';
                            logStep('changes', state.innerError);
                            return;
                        }
                        state.requestCreated = true;
                        logStep('changes', 'request created');
                        try {
                            if (typeof req.setCreationDate_ === 'function') {
                                req.setCreationDate_(ObjC.classes.NSDate.date());
                                logStep('changes', 'creationDate set to now');
                            }
                        } catch (dateErr) {
                            logStep('changes', 'creationDate set failed: ' + String(dateErr));
                        }

                        if (isVideo || typeof PHAssetCreationRequest.creationRequestForAssetFromImageAtFileURL_ !== 'function') {
                            const PHAssetResourceCreationOptions = ObjC.classes.PHAssetResourceCreationOptions;
                            const opts = PHAssetResourceCreationOptions.alloc().init();
                            opts.setShouldMoveFile_(true);
                            logStep('changes', 'options ok (shouldMoveFile=YES)');

                            req.addResourceWithType_fileURL_options_(resourceType, url, opts);
                            logStep('changes', 'addResourceWithType called type=' + resourceType);
                        } else {
                            logStep('changes', 'using creationRequestForAssetFromImageAtFileURL');
                        }

                        const ph = req.placeholderForCreatedAsset();
                        if (ph !== null) {
                            state.localId = ph.localIdentifier().toString();
                            logStep('changes', 'localId = ' + state.localId);
                        }
                    } catch (inner) {
                        state.innerError = String(inner);
                        logStep('changes', 'INNER ERR: ' + state.innerError);
                    }
                }
            });
            logStep('import', 'E: changesBlock constructed');

            // completion 块（void(^)(BOOL, NSError*)）
            const completionBlock = new ObjC.Block({
                retType: 'void',
                argTypes: ['bool', 'object'],
                implementation: function (success, error) {
                    try {
                        let errMsg = null, errCode = null, errDomain = null, errUnderlying = null, errUserInfo = null;
                        if (error !== null) {
                            try { errMsg = error.localizedDescription().toString(); } catch (_) { }
                            try { errCode = +error.code(); } catch (_) { }
                            try { errDomain = error.domain().toString(); } catch (_) { }
                            try {
                                const ui = error.userInfo();
                                if (ui !== null) errUserInfo = ui.description().toString();
                            } catch (_) { }
                            try {
                                const underlying = error.userInfo() && error.userInfo().objectForKey_('NSUnderlyingError');
                                if (underlying !== null && underlying !== undefined) {
                                    errUnderlying = underlying.localizedDescription().toString();
                                }
                            } catch (_) { }
                        }
                        logStep('completion', 'success=' + success + ' code=' + errCode + ' domain=' + errDomain + ' err=' + errMsg);
                        if (errUserInfo) logStep('completion', 'userInfo=' + errUserInfo);
                        if (errUnderlying) logStep('completion', 'underlying=' + errUnderlying);
                        if (!success) {
                            clearTimeout(timeoutId);
                            safeResolve({
                                ok: false,
                                localIdentifier: state.localId,
                                requestCreated: state.requestCreated,
                                error: errMsg || state.innerError || null,
                                errorCode: errCode,
                                errorDomain: errDomain,
                                errorUnderlying: errUnderlying,
                                errorUserInfo: errUserInfo,
                                tmpPath: state.tmpPath || null,
                            });
                            return;
                        }
                        waitForAssetVisible(state.localId, 10, function (visible) {
                            const expectedMediaType = isVideo ? 2 : 1;
                            const actualMediaType = visible && visible.ok ? Number(visible.mediaType) : null;
                            const mediaTypeOk = visible && visible.ok && actualMediaType === expectedMediaType;
                            clearTimeout(timeoutId);
                            safeResolve({
                                ok: !!mediaTypeOk,
                                localIdentifier: state.localId,
                                requestCreated: state.requestCreated,
                                error: mediaTypeOk
                                    ? null
                                    : (visible && visible.ok
                                        ? ('created asset mediaType mismatch: expected=' + expectedMediaType + ' actual=' + actualMediaType)
                                        : ('created asset not fetchable: ' + visible.error)),
                                errorCode: errCode,
                                errorDomain: errDomain,
                                errorUnderlying: errUnderlying,
                                errorUserInfo: errUserInfo,
                                tmpPath: state.tmpPath || null,
                                verify: visible,
                            });
                        });
                    } catch (e) {
                        clearTimeout(timeoutId);
                        safeResolve({ ok: false, error: 'completion handler crash: ' + String(e) });
                    }
                }
            });
            logStep('import', 'F: completionBlock constructed');

            // 把 block 挂到 globalThis，防止 GC
            globalThis.__photoBlocks = globalThis.__photoBlocks || [];
            globalThis.__photoBlocks.push(changesBlock);
            globalThis.__photoBlocks.push(completionBlock);
            logStep('import', 'G: blocks retained globally');

            library.performChanges_completionHandler_(changesBlock, completionBlock);
            logStep('import', 'H: performChanges called (waiting for completion)');
        } catch (e) {
            clearTimeout(timeoutId);
            safeResolve({ ok: false, error: 'outer crash: ' + String(e), stack: e.stack });
        }
    });
}

function waitForAssetVisible(localId, attemptsLeft, done) {
    if (!localId) {
        done({ ok: false, error: 'missing localIdentifier' });
        return;
    }
    const fetched = fetchByLocalIdentifier(localId);
    if (fetched && fetched.ok) {
        done(fetched);
        return;
    }
    if (attemptsLeft <= 1) {
        done(fetched || { ok: false, error: 'asset not found' });
        return;
    }
    setTimeout(function () {
        waitForAssetVisible(localId, attemptsLeft - 1, done);
    }, 1000);
}

function photoAuthStatus() {
    try {
        const fwOk = ensurePhotosFramework();
        if (!fwOk.ok) return { ok: false, error: fwOk.error, diag: fwOk.diag };
        const PHPhotoLibrary = ObjC.classes.PHPhotoLibrary;
        let addOnly = null, readWrite = null, legacy = null;
        try { legacy = PHPhotoLibrary.authorizationStatus(); } catch (_) { }
        try { addOnly = PHPhotoLibrary.authorizationStatusForAccessLevel_(1); } catch (_) { }
        try { readWrite = PHPhotoLibrary.authorizationStatusForAccessLevel_(2); } catch (_) { }
        return { ok: true, legacy: legacy, addOnly: addOnly, readWrite: readWrite,
                 meaning: '0=notDetermined,1=restricted,2=denied,3=authorized,4=limited' };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

function fetchByLocalIdentifier(localId) {
    try {
        const fwOk = ensurePhotosFramework();
        if (!fwOk.ok) return { ok: false, error: fwOk.error };
        const PHAsset = ObjC.classes.PHAsset;
        const PHPhotoLibrary = ObjC.classes.PHPhotoLibrary;
        const PHFetchOptions = ObjC.classes.PHFetchOptions;
        const ids = nsStringArray([localId]);
        const libraries = ObjC.chooseSync({ class: PHPhotoLibrary });

        for (let libraryIndex = 0; libraryIndex < libraries.length; libraryIndex++) {
            const options = PHFetchOptions.alloc().init();
            if (typeof options.setPhotoLibrary_ !== 'function') continue;
            options.setPhotoLibrary_(libraries[libraryIndex]);

            const result = PHAsset.fetchAssetsWithLocalIdentifiers_options_(ids, options);
            const count = +result.count();
            logStep('fetch', 'library=' + libraryIndex + ' count=' + count);
            if (count === 0) continue;

            const asset = result.objectAtIndex_(0);
            let creationDate = null;
            try {
                const d = asset.creationDate();
                if (d !== null) creationDate = d.description().toString();
            } catch (_) { }
            return {
                ok: true,
                count: count,
                libraryIndex: libraryIndex,
                localIdentifier: asset.localIdentifier().toString(),
                mediaType: +asset.mediaType(),
                mediaSubtypes: +asset.mediaSubtypes(),
                pixelWidth: +asset.pixelWidth(),
                pixelHeight: +asset.pixelHeight(),
                duration: +asset.duration(),
                creationDate: creationDate,
            };
        }
        return { ok: false, error: 'asset not found', count: 0 };
    } catch (e) {
        return { ok: false, error: String(e), stack: e.stack };
    }
}

/** Brief untrashed library listing via PhotoKit (excludes Recently Deleted). */
function listUntrashedAssets(limit) {
    try {
        const fwOk = ensurePhotosFramework();
        if (!fwOk.ok) return { ok: false, error: fwOk.error, assets: [] };
        const max = Math.max(1, Math.min(Number(limit) || 200, 500));
        const PHAsset = ObjC.classes.PHAsset;
        const PHFetchOptions = ObjC.classes.PHFetchOptions;
        const NSSortDescriptor = ObjC.classes.NSSortDescriptor;
        const options = PHFetchOptions.alloc().init();
        try {
            const desc = NSSortDescriptor.sortDescriptorWithKey_ascending_('creationDate', false);
            options.setSortDescriptors_([desc]);
        } catch (_) { }
        const result = PHAsset.fetchAssetsWithOptions_(options);
        const total = +result.count();
        const n = Math.min(total, max);
        const assets = [];
        for (let i = 0; i < n; i++) {
            const asset = result.objectAtIndex_(i);
            const lid = asset.localIdentifier().toString();
            const mediaType = +asset.mediaType(); // 1=image 2=video
            assets.push({
                localIdentifier: lid,
                uuid: lid.split('/')[0],
                mediaType: mediaType === 2 ? 'video' : 'image',
                pixelWidth: +asset.pixelWidth(),
                pixelHeight: +asset.pixelHeight(),
                duration: +asset.duration(),
                source: 'photokit',
            });
        }
        return { ok: true, count: assets.length, total: total, assets: assets };
    } catch (e) {
        return { ok: false, error: String(e), stack: e.stack, assets: [] };
    }
}

function safeString(value) {
    try {
        if (value === null || value === undefined) return null;
        return value.toString();
    } catch (e) {
        return '<string-error:' + String(e) + '>';
    }
}

function nsStringArray(values) {
    const arr = ObjC.classes.NSMutableArray.arrayWithCapacity_(values.length);
    for (const value of values) {
        arr.addObject_(ObjC.classes.NSString.stringWithString_(value));
    }
    return arr;
}

function collectMediaDeleteGroups(localIdentifiers) {
    const PHPhotoLibrary = ObjC.classes.PHPhotoLibrary;
    const PHFetchOptions = ObjC.classes.PHFetchOptions;
    const PHAsset = ObjC.classes.PHAsset;
    const NSMutableArray = ObjC.classes.NSMutableArray;
    const libraries = ObjC.chooseSync({ class: PHPhotoLibrary });
    const ids = nsStringArray(localIdentifiers);
    const seen = {};
    const groups = [];
    const retained = [ids];

    logStep('delete', 'PHPhotoLibrary live instances: ' + libraries.length);
    for (let libraryIndex = 0; libraryIndex < libraries.length; libraryIndex++) {
        const options = PHFetchOptions.alloc().init();
        if (typeof options.setPhotoLibrary_ !== 'function') {
            logStep('delete', 'PHFetchOptions.setPhotoLibrary_ missing');
            continue;
        }
        options.setPhotoLibrary_(libraries[libraryIndex]);
        retained.push(options);

        const fetched = PHAsset.fetchAssetsWithLocalIdentifiers_options_(ids, options);
        const count = +fetched.count();
        retained.push(fetched);
        logStep('delete', 'fetch library=' + libraryIndex + ' count=' + count);
        if (count === 0) continue;

        const deleteList = NSMutableArray.arrayWithCapacity_(count);
        for (let i = 0; i < count; i++) {
            const asset = fetched.objectAtIndex_(i);
            const localId = safeString(asset.localIdentifier());
            if (!localId || seen[localId]) continue;
            const mediaType = +asset.mediaType();
            if (mediaType !== 1 && mediaType !== 2) continue;
            seen[localId] = true;
            deleteList.addObject_(asset);
        }

        const deleteCount = +deleteList.count();
        if (deleteCount > 0) {
            groups.push({
                library: libraries[libraryIndex],
                deleteList: deleteList,
                deleteCount: deleteCount,
                libraryIndex: libraryIndex,
            });
            retained.push(deleteList);
        }
    }

    return { groups: groups, found: Object.keys(seen), retained: retained };
}

function deleteMediaAssetsByLocalIdentifiers(localIdentifiers) {
    return new Promise(function (resolve) {
        if (!Array.isArray(localIdentifiers) || localIdentifiers.length === 0) {
            resolve({ ok: true, requested: 0, found: [], deleted: 0, completions: [] });
            return;
        }

        let timeoutId = null;
        try {
            const fwOk = ensurePhotosFramework();
            if (!fwOk.ok) {
                resolve({ ok: false, error: fwOk.error, diag: fwOk.diag });
                return;
            }

            const collected = collectMediaDeleteGroups(localIdentifiers);
            const groups = collected.groups;
            const found = collected.found;
            if (groups.length === 0) {
                resolve({
                    ok: false,
                    requested: localIdentifiers.length,
                    found: found,
                    deleted: 0,
                    completions: [],
                    error: 'no matching media assets found',
                });
                return;
            }

            const completions = [];
            globalThis.__batchDeleteMediaBlocks = collected.retained;
            timeoutId = setTimeout(function () {
                resolve({
                    ok: false,
                    requested: localIdentifiers.length,
                    found: found,
                    deleted: completions.reduce((n, item) => n + (item.success ? item.count : 0), 0),
                    completions: completions,
                    error: 'timeout after 60s',
                });
            }, 60000);

            function runGroup(index) {
                if (index >= groups.length) {
                    clearTimeout(timeoutId);
                    const failed = completions.filter((item) => !item.success);
                    resolve({
                        ok: failed.length === 0,
                        requested: localIdentifiers.length,
                        found: found,
                        deleted: completions.reduce((n, item) => n + (item.success ? item.count : 0), 0),
                        completions: completions,
                        error: failed.length ? failed.map((item) => item.error).join('; ') : null,
                    });
                    return;
                }

                const group = groups[index];
                const changesBlock = new ObjC.Block({
                    retType: 'void',
                    argTypes: [],
                    implementation: function () {
                        ObjC.classes.PHAssetChangeRequest.deleteAssets_(group.deleteList);
                        logStep('delete', 'deleteAssets library=' + group.libraryIndex + ' count=' + group.deleteCount);
                    },
                });
                const completionBlock = new ObjC.Block({
                    retType: 'void',
                    argTypes: ['bool', 'object'],
                    implementation: function (success, error) {
                        completions.push({
                            libraryIndex: group.libraryIndex,
                            count: group.deleteCount,
                            success: !!success,
                            error: error !== null ? safeString(error.localizedDescription()) : null,
                        });
                        runGroup(index + 1);
                    },
                });

                globalThis.__batchDeleteMediaBlocks.push(changesBlock, completionBlock);
                group.library.performChanges_completionHandler_(changesBlock, completionBlock);
            }

            runGroup(0);
        } catch (e) {
            if (timeoutId !== null) clearTimeout(timeoutId);
            resolve({ ok: false, error: String(e), stack: e.stack || null });
        }
    });
}

function deleteVideoAssetsByLocalIdentifiers(localIdentifiers) {
    return deleteMediaAssetsByLocalIdentifiers(localIdentifiers);
}

rpc.exports = {
    importVideoFromPath: (p) => importAsset(p, true),
    importImageFromPath: (p) => importAsset(p, false),
    deleteMediaAssetsByLocalIdentifiers: deleteMediaAssetsByLocalIdentifiers,
    deleteVideoAssetsByLocalIdentifiers: deleteVideoAssetsByLocalIdentifiers,
    photoAuthStatus: photoAuthStatus,
    fetchByLocalIdentifier: fetchByLocalIdentifier,
    listUntrashedAssets: listUntrashedAssets,
    probe: probeUrlAndClass,
};

send({ type: 'ready', module: 'photos_import_agent' });
