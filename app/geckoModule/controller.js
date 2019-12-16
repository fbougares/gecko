import uuidv4 from 'uuid/v4'
import Swal from 'sweetalert2'
import * as Diff from 'diff'
import videojs from 'video.js'

import * as constants from './constants'
import initWaveSurfer from './wavesurfer.js'

import { config }  from './config.js'

import Shortcuts from './shortcuts'
import wavesurferEvents from './waveSurferEvents'

import { 
    parse as parseTextFormats,
    convert as convertTextFormats
} from './textFormats'

import { 
    jsonStringify,
    secondsToMinutes, 
    sortDict,
    copyRegion,
    parseAndLoadAudio,
    sortLegend,
} from './utils'

import {
    loadingModal,
    shortcutsModal
} from './modals'

class MainController {
    constructor($scope, $uibModal, dataManager, dataBase, eventBus, discrepancyService, historyService, $timeout, $interval) {
        this.dataManager = dataManager;
        this.dataBase = dataBase;
        this.eventBus = eventBus
        this.$uibModal = $uibModal;
        this.$scope = $scope;
        this.$timeout = $timeout
        this.$interval = $interval
        this.isServerMode = false
        this.proofReadingView = false
        this.shortcuts = new Shortcuts(this, constants)
        this.shortcuts.bindKeys()
        this.eventBus = eventBus
        this.discrepancyService = discrepancyService
        this.historyService = historyService
    }

    loadApp(config) {
        const urlParams = new URLSearchParams(window.location.search)
        const saveMode = urlParams.get('save_mode')
        if (saveMode) {
            if (saveMode === 'server') {
                this.isServerMode = true
            } else if (saveMode === 'local') {
                this.isServerMode = false
            }
        }

        const audio = urlParams.get('audio')
        let formats = ['rttm', 'tsv', 'json', 'ctm']
        formats = formats.map((f) => {
            if (urlParams.get(f)) {
                return {
                    format: f,
                    url: urlParams.get(f)
                }
            }
            return null
        }).filter(Boolean)
        let serverConfig = null
        if (audio || formats.length) {
            serverConfig = {
                mode: 'server',
                ctms: []
            }

            if (audio) {
                serverConfig.audio = {
                    url: audio
                }
            }

            if (formats.length) {
                formats.forEach(f => {
                    const fileName = f.url.split('/').pop().split('.')[0]
                    serverConfig.ctms = [
                        {
                            url: f.url,
                            fileName: fileName + '.' + f.format
                        }
                    ]
                })
            }
        }
        if (config.mode === 'server' || serverConfig) {
            this.loadServerMode(serverConfig ? serverConfig : config);
        } else {
            this.loadClientMode();
        }
    }

    setInitialValues () {
        this.loader = false
        this.audioFileName = null
        this.currentTime = '00:00'
        this.currentTimeSeconds = 0
        this.zoomLevel = constants.ZOOM
        this.isPlaying = false
        this.playbackSpeeds = constants.PLAYBACK_SPEED
        this.currentPlaybackSpeed = 1
        this.videoMode = false
        this.showSpectrogram = false
        this.showSpectrogramButton = false
        this.spectrogramReady = false
        this.currentGainProc = 100

        // history variables
        this.historyService.reset()

        this.isRegionClicked = false;

        this.allRegions = []
    }

    setConstants () {
        this.minGainProc = constants.MIN_GAIN * 100
        this.maxGainProc = constants.MAX_GAIN * 100
        this.maxZoom = constants.MAX_ZOOM
        this.playbackSpeeds = constants.PLAYBACK_SPEED
        if (config.wavesurfer.useSpectrogram) {
            this.showSpectrogramButton = true
        }
    }

    reset () {
        this.wavesurfer && this.wavesurfer.destroy()
        this.$scope.$evalAsync(() => {
            this.setInitialValues()
        })
    }

    init() {
        this.setConstants()
        this.setInitialValues()
        
        this.wavesurfer = initWaveSurfer();
        this.wavesurferElement = this.wavesurfer.drawer.container;

        this.ctmData = [];
        this.ready = false;

        this.eventBus.on('wordClick', (word, e) => {
            this.seek(word.start, 'right')
            e.preventDefault()
            e.stopPropagation()
        })

        this.eventBus.on('regionTextChanged', (regionId) => {
            let currentRegion = this.getRegion(regionId)
            this.historyService.addHistory(currentRegion)
            this.historyService.undoStack.push([constants.REGION_TEXT_CHANGED_OPERATION_ID, regionId])

            this.eventBus.trigger('geckoChanged', {
                event: 'regionTextChanged',
                data: currentRegion
            })
        })

        this.eventBus.on('editableFocus', (editableRegion, fileIndex) => {
            this.selectedRegion = editableRegion
            this.selectedFileIndex = fileIndex
            this.seek(editableRegion.start, 'right')
            //this.eventBus.trigger('proofReadingScroll', editableRegion, fileIndex)
        })

        document.onkeydown = (e) => {
            if (e.key === 'Escape') {
                if (document.activeElement) {
                    document.activeElement.blur();
                }
                return;
            }

            // this.shortcuts.checkKeys(e)
            this.$scope.$evalAsync()
            /* if (e.key === 'ArrowRight' && isDownCtrl) {
                self.jumpNextDiscrepancy();
            } */
        };

        this.bindWaveSurferEvents()

        this.$interval(() => {
            this.saveToDB()
        }, constants.SAVE_THRESHOLD)
    }

    bindWaveSurferEvents () {
        this.wavesurferElement.onclick = (e) => {
            if (!this.isRegionClicked) {
                this.calcCurrentFileIndex(e);
                // self.deselectRegion();
            }

            this.isRegionClicked = false;
        };

        this.wavesurferElement.addEventListener('mousedown', (e) => {
            if (e.ctrlKey || e.metaKey) {
                this.isDownCtrl = true
            }
        })

        this.wavesurferElement.addEventListener('mouseup', () => {
            this.isDownCtrl = false
        })

        this.wavesurfer.on('audioprocess', () => wavesurferEvents.audioProcess(this))
        this.wavesurfer.on('error', (e) => wavesurferEvents.error(this, e))
        this.wavesurfer.on('loading', () => wavesurferEvents.loading(this))
        this.wavesurfer.on('ready', () => wavesurferEvents.ready(this))
        this.wavesurfer.on('seek', () => wavesurferEvents.seek(this));
        this.wavesurfer.on('region-created', (region) => wavesurferEvents.regionCreated(this, region));
        this.wavesurfer.on('region-updated', (region) => wavesurferEvents.regionUpdated(this, region))
        this.wavesurfer.on('region-update-end', (region) => wavesurferEvents.regionUpdateEnd(this, region))
        // this.wavesurfer.on('region-in', (region) => wavesurferEvents.regionIn(this, region))
        // this.wavesurfer.on('region-out', (region) => wavesurferEvents.regionOut(this, region))
        this.wavesurfer.on('region-click', (region) => wavesurferEvents.regionClick(this, region))
        this.wavesurfer.on('pause', () => wavesurferEvents.pause(this))
    }

    zoomIntoRegion () {
        if (this.selectedRegion) {
            const delta = this.selectedRegion.end - this.selectedRegion.start
            const wavesurferWidth = this.wavesurfer.container.offsetWidth

            let zoomLevel = wavesurferWidth / delta

            if (zoomLevel > constants.MAX_ZOOM){
                zoomLevel = constants.MAX_ZOOM
            }

            this.wavesurfer.zoom(zoomLevel);
            this.noUpdateZoom = true
            this.zoomLevel = zoomLevel
            this.seek(this.selectedRegion.start)

            const midPosition = (this.selectedRegion.start + this.selectedRegion.end) / 2 * zoomLevel
            this.wavesurfer.container.children[0].scrollLeft = midPosition - (wavesurferWidth / 2)
            // const startPosition = this.selectedRegion.start * zoomLevel
            // this.wavesurfer.container.children[0].scrollLeft = startPosition
        }
    }

    async saveToDB () {
        await this.dataBase.clearFiles()
        await this.dataBase.saveFiles(this.filesData)
    }

    handleCtm() {
        if (this.ctmData.length !== 2 || this.filesData.length !== 2) return;

        let diff = Diff.diffArrays(this.ctmData[0], this.ctmData[1], {
            comparator: (x, y) => {
                return x.text === y.text;
            }
        });

        // discrepancies is also the indication if we are in ctm comparing mode
        this.discrepancies = [];
        this.wavesurfer.params.autoCenter = true;

        const handleDiscrepancy = (discrepancy, diffItem) => {
            if (diffItem.removed) {
                if (discrepancy.old) {
                    throw 'Does not suppose to happen'
                }
                discrepancy.old = diffItem.value;
            } else {
                if (discrepancy.new) {
                    throw 'Does not suppose to happen'
                }
                discrepancy.new = diffItem.value;
            }
        }

        for (let i = 0, length = diff.length; i < length; i++) {
            if (diff[i].removed || diff[i].added) {
                let discrepancy = {};
                handleDiscrepancy(discrepancy, diff[i])

                i++;

                //check for the other side of the discrepancy
                if (i < diff.length && (diff[i].removed || diff[i].added)) {
                    handleDiscrepancy(discrepancy, diff[i])
                }

                this.discrepancies.push(discrepancy);
            }
        }

        this.discrepancies.forEach((discrepancy) => {
            let oldStart = Infinity;
            let oldEnd = 0;

            if (discrepancy.old) {
                discrepancy.oldText = discrepancy.old.map(x => x.text).join(' ');
                oldStart = discrepancy.old[0].start;
                oldEnd = discrepancy.old[discrepancy.old.length - 1].end;
            }

            let newStart = Infinity;
            let newEnd = 0;

            if (discrepancy.new) {
                discrepancy.newText = discrepancy.new.map(x => x.text).join(' ');
                newStart = discrepancy.new[0].start;
                oldEnd = discrepancy.new[discrepancy.new.length - 1].end;
            }

            if (newStart > oldStart) {
                discrepancy.start = oldStart;
            } else {
                discrepancy.start = newStart;
            }

            if (newEnd > oldEnd) {
                discrepancy.end = newEnd;
            } else {
                discrepancy.end = oldEnd;
            }

            discrepancy.startDisp = secondsToMinutes(discrepancy.start);
            discrepancy.endDisp = secondsToMinutes(discrepancy.end);
        })
    }

    fixRegionsOrder(region) {
        if (region.data.isDummy) {
            return
        }

        var prevRegion = this.findClosestRegionToTime(region.data.fileIndex, region.start, true);

        if (prevRegion) {
            region.prev = prevRegion.id;
            prevRegion.next = region.id;
        } else {
            region.prev = null;
        }

        var nextRegion = this.findClosestRegionToTime(region.data.fileIndex, region.end);

        if (nextRegion) {
            region.next = nextRegion.id;
            nextRegion.prev = region.id;
        } else {
            region.next = null;
        }
    }

    regionPositionUpdated(region) {
        var self = this;

        self.selectRegion(region);

        if (!region.data.initFinished) {
            region.data.initFinished = true;
            this.fixRegionsOrder(region);
        }

        if (!region.data.isDummy) {
            var prevRegion = this.getRegion(region.prev);
            var nextRegion = this.getRegion(region.next);

            if (prevRegion !== null) {
                if (region.start < prevRegion.start + constants.MINIMUM_LENGTH) {
                    region.start = prevRegion.start + constants.MINIMUM_LENGTH;
                    region.end = Math.max(region.start + constants.MINIMUM_LENGTH, region.end);
                }

                if (region.start < prevRegion.end) {
                    prevRegion.end = region.start;
                    self.historyService.updateOtherRegions.add(prevRegion);
                    self.regionUpdated(prevRegion);
                }
            }

            if (nextRegion !== null) {
                if (region.end > nextRegion.end - constants.MINIMUM_LENGTH) {
                    region.end = nextRegion.end - constants.MINIMUM_LENGTH;
                    region.start = Math.min(region.start, region.end - constants.MINIMUM_LENGTH);
                }

                if (region.end > nextRegion.start) {
                    nextRegion.start = region.end;
                    self.historyService.updateOtherRegions.add(nextRegion);
                    self.regionUpdated(nextRegion);
                }
            }
        }

        self.regionUpdated(region);
    }

    // change region visually
    regionUpdated(region) {
        // fix first and last words
        let words = region.data.words;
        words[0].start = region.start;
        words[words.length - 1].end = region.end;

        region.element.style.background = '';

        if (region.data.speaker.length === 0) {
            region.color = constants.UNKNOWN_SPEAKER_COLOR;

            if (region.data && region.data.isDummy) {
                region.element.style.background = 'repeating-linear-gradient(135deg, rgb(128, 128, 128) 20px, rgb(180, 180, 180) 40px) rgb(128, 128, 128)'
            }
        } else if (region.data.speaker.length === 1) {
            region.color = this.filesData[region.data.fileIndex].legend[region.data.speaker[0]];

        } else {
            let line_width = 20;

            let colors = region.data.speaker.map((s, i) =>
                `${this.filesData[region.data.fileIndex].legend[s]} ${(i + 1) * line_width}px`
            ).join(',');

            region.element.style.background =
                `repeating-linear-gradient(135deg, ${colors})`

        }

        //TODO: This also happens at other times so we cannot determine things after it
        // unless we fork the repo and set an "afterrender" event so we could change the region however we'd like
        region.updateRender();

        // region.element.title = region.data.speaker;

        this.$scope.$evalAsync();
    }

    insertDummyRegion () {
        const { dummyRegion } = this
        const truncateRegions = []

        this.iterateRegions(region => {
            let overlap = false
            if (region.start >= dummyRegion.start && region.end <= dummyRegion.end
                || region.start <= dummyRegion.end && region.end >= dummyRegion.end
                || region.start <= dummyRegion.start && region.end <= dummyRegion.end && region.end >= dummyRegion.start) {
                overlap = true
            }

            if (overlap && region !== dummyRegion) {
                truncateRegions.push(region)
            }
        }, this.selectedFileIndex)

        if (truncateRegions.length) {
            const newRegionWords = []
            const newRegionSpeakers = []
            let regionsToDel = []
            let regionsToAdd = []
            truncateRegions.forEach(r => {
                const speakers = JSON.parse(JSON.stringify(r.data.speaker))
                speakers.forEach(s => {
                    if (!newRegionSpeakers.includes(s)) {
                        newRegionSpeakers.push(s)
                    }
                })
                const words = JSON.parse(JSON.stringify(r.data.words))
                words.forEach(w => {
                    if (w.start >= dummyRegion.start && w.end <= dummyRegion.end) {
                        newRegionWords.push(w)
                    }
                })

                if (r.start >= dummyRegion.start && r.end <= dummyRegion.end) { 
                    /* region is fully overlaped */
                    regionsToDel.push(r.id)
                    this.__deleteRegion(r)
                } else if (r.start <= dummyRegion.end && r.end >= dummyRegion.end) {
                    /* region is overlaped from right side */
                    let original = copyRegion(r)
                    regionsToDel.push(original.id)

                    delete original.id
                    original.start = dummyRegion.end

                    let words = JSON.parse(JSON.stringify(r.data.words))
                    let i
                    for (i = 0, length = words.length; i < length; i++) {
                        if (words[i].start > dummyRegion.end) break
                    }

                    original.data.words = words.slice(i)

                    this.__deleteRegion(r)
                    original = this.wavesurfer.addRegion(original)
                    regionsToAdd.push(original.id)
                } else if (r.start <= dummyRegion.start && r.end <= dummyRegion.end && r.end >= dummyRegion.start) {
                    /* region is overlaped from left side */
                    let original = copyRegion(r)
                    regionsToDel.push(original.id)

                    delete original.id
                    original.end = dummyRegion.start

                    let words = JSON.parse(JSON.stringify(r.data.words))
                    let i
                    for (i = 0, length = words.length; i < length; i++) {
                        if (words[i].start > dummyRegion.start) break
                    }

                    original.data.words = words.slice(0, i)

                    this.__deleteRegion(r)
                    original = this.wavesurfer.addRegion(original)
                    regionsToAdd.push(original.id)
                }
            })
            
            const newRegion = this.wavesurfer.addRegion({
                start: dummyRegion.start,
                end: dummyRegion.end,
                data: {
                    initFinished: true,
                    fileIndex: this.selectedFileIndex,
                    speaker: newRegionSpeakers,
                    words: newRegionWords
                },
                drag: false,
                minLength: constants.MINIMUM_LENGTH
            })

            regionsToDel.push(dummyRegion.id)
            const changedIds = [ newRegion.id, ...regionsToAdd, ...regionsToDel ]

            this.historyService.undoStack.push(changedIds)
            regionsToDel.forEach((id) => this.historyService.regionsHistory[id].push(null))

            this.dummyRegion.remove()
            this.dummyRegion = null
        }

        this.$timeout(() => {
            this.setAllRegions()
            this.eventBus.trigger('rebuildProofReading', this.selectedRegion, this.selectedFileIndex)
        })
    }

    updateView() {
        this.selectRegion()
        this.silence = this.calcSilenceRegion()
        this.setCurrentTime()
        this.setAllRegions()
        this.calcCurrentRegions()
        this.discrepancyService.updateSelectedDiscrepancy(this)
    }

    setAllRegions() {
        for (let i = 0; i < this.filesData.length; i++) {
            const ret = []
            this.iterateRegions((r) => {
                if (!r.data.isDummy) {
                    ret.push(r)
                }
            }, i, true)
            this.allRegions[i] = ret.reduce((acc, current) => {
                const last = acc[acc.length - 1]
                if (last && last.length) {
                    if (angular.equals(last[0].data.speaker, current.data.speaker)) {
                        last.push(current)
                    } else {
                        acc.push([ current ])
                    }
                } else {
                    acc.push([ current ])
                }
                return acc
            }, [])
        }      
    }

    calcCurrentFileIndex(e) {
        var scrollBarHeight = 20;
        var wavesurferHeight = this.wavesurfer.getHeight() - scrollBarHeight;

        // vertical click location
        var posY = e.pageY - e.target.offsetTop;

        this.selectedFileIndex = parseInt(posY / wavesurferHeight * this.filesData.length);
    }

    deselectRegion(region) {
        if (region !== undefined) {
            region.element.classList.remove('selected-region');
            if (this.selectedRegion === region) {
                this.selectedRegion = undefined;
            }
        } else if (this.selectedRegion) {
            if (this.selectedRegion.element) {
                this.selectedRegion.element.classList.remove('selected-region');
            }
            this.selectedRegion = undefined;
        }
    }

    calcCurrentRegions() {
        for (let i = 0; i < this.filesData.length; i++) {
            const currentRegion = this.getCurrentRegion(i);
            if (currentRegion && currentRegion !== this.currentRegions[i]) {
                if (this.proofReadingView) {
                    if (currentRegion !== this.selectedRegion) {
                        this.eventBus.trigger('resetEditableWords', currentRegion)
                    }

                    if (this.isPlaying) {
                        this.eventBus.trigger('proofReadingScrollToRegion', currentRegion)
                    }
                } else {
                    this.eventBus.trigger('resetEditableWords', currentRegion)
                }
                
            } else if (!currentRegion) {
                this.eventBus.trigger('cleanEditableDOM', i)
            }
            this.currentRegions[i] = currentRegion
        }

        this.$scope.$$postDigest(this.updateSelectedWordInFiles.bind(this));
    }

    getCurrentRegion(fileIndex) {
        let region;

        var time = this.wavesurfer.getCurrentTime();
        this.iterateRegions((r) => {
            if (time >= r.start - constants.TOLERANCE && time <= r.end + constants.TOLERANCE) {
                region = r;
            }
        }, fileIndex);

        return region;
    }

    selectRegion(region) {
        if (!region) {
            region = this.getCurrentRegion(this.selectedFileIndex);
        }

        this.deselectRegion();

        if (!region) { 
            return
        }

        region.element.classList.add('selected-region');

        this.selectedRegion = region;
    }

    jumpRegion(next) {
        var region;

        if (this.selectedRegion) {
            if (next) {
                region = this.wavesurfer.regions.list[this.selectedRegion.next];
            } else {
                region = this.wavesurfer.regions.list[this.selectedRegion.prev];
            }
        } else {
            if (next) {
                region = this.findClosestRegionToTime(this.selectedFileIndex, this.wavesurfer.getCurrentTime());
            } else {
                region = this.findClosestRegionToTime(this.selectedFileIndex, this.wavesurfer.getCurrentTime(), true);
            }
        }

        if (region) {
            region.play();
        }
    }

    updateSelectedWordInFile(fileIndex) {
        var self = this;

        let time = self.wavesurfer.getCurrentTime();

        let region = self.currentRegions[fileIndex];
        if (!region) return;

        let words = region.data.words;
        if (!words) return;

        words.forEach(word => {
            if (word.start <= time && word.end >= time) {
                let newSelectedWords = document.querySelectorAll(`[word-uuid="${word.uuid}"]`)

                if (newSelectedWords) {
                    newSelectedWords.forEach(w => w.classList.add('selected-word'))
                }
            }
        });
    }

    updateSelectedWordInFiles() {
        // unselect words
        document.querySelectorAll('.selected-word').forEach((elem) => {
            elem.classList.remove('selected-word');
        });

        for (let i = 0; i < this.filesData.length; i++) {
            this.updateSelectedWordInFile(i);
        }
    }

    getRegion(id) {
        if (!id) {
            return null;
        }

        return this.wavesurfer.regions.list[id];
    }

    iterateRegions(func, fileIndex, sort) {
        var regions = this.wavesurfer.regions.list;

        if (sort) {
            regions = sortDict(regions, 'start');
        }

        Object.keys(regions).forEach(function (key) {
            var region = regions[key];
            if (fileIndex !== undefined && region.data.fileIndex !== fileIndex) {
                return;
            }
            // if (speaker !== undefined && region.data.speaker !== speaker) {
            //     return;
            // }

            func(region)
        })
    }

    findClosestRegionToTime(fileIndex, time, before) {
        // Assuming time is not contained in any region
        var closest = null;
        this.iterateRegions((region) => {
            if (before) {
                if (region.start < time - 0.01 && (closest === null || region.start > closest.start) && !region.data.isDummy) {
                    closest = region;
                }
            } else {
                if (region.end > time && (closest === null || region.end < closest.end) && !region.data.isDummy) {
                    closest = region;
                }
            }

        }, fileIndex);

        return closest;
    }

    findClosestRegionToTimeBackward(fileIndex, time) {
        var closest = null;
        this.iterateRegions((region) => {
            if (region.end < time && (closest === null || region.end > closest.end)) {
                closest = region;
            }
        }, fileIndex);

        return closest;
    }

    createSpeakerLegends() {
        var self = this;

        // First aggregate all speakers, overwrite if "color" field is presented anywhere.
        // We set the same speaker for different files with the same color this way,
        // // determined by the last "color" field or one of the colors in the list
        let speakersColors = Object.assign({}, constants.defaultSpeakers);

        self.filesData.forEach(fileData => {
            let colorIndex = 0;

            fileData.legend = Object.assign({}, constants.defaultSpeakers);

            fileData.data.forEach(monologue => {
                if (!monologue.speaker.id) return;

                let speakerId = monologue.speaker.id;

                if (speakerId === constants.UNKNOWN_SPEAKER) {
                    speakerId = '';
                }

                let speakers = String(speakerId).split(constants.SPEAKERS_SEPARATOR).filter(x => x);

                // TODO: remove and put colors as metadata outside monologues
                // also, maybe save representativeStart,representativeStart there too
                if (speakers.length === 1) {
                    // forcefully set the color of the speaker
                    if (monologue.speaker.color) {
                        speakersColors[speakerId] = monologue.speaker.color;
                    }
                }

                speakers.forEach(s => {

                    // Encounter the speaker id for the first time (among all files)
                    if (!(s in speakersColors)) {
                        speakersColors[s] = constants.SPEAKER_COLORS[colorIndex];
                        colorIndex = (colorIndex + 1) % constants.SPEAKER_COLORS.length;
                    }
                    fileData.legend[s] = undefined;
                });
            })

            fileData.legend = sortLegend(fileData.legend);
        });

        // Set the actual colors for each speaker
        self.filesData.forEach(fileData => {
            Object.keys(fileData.legend).forEach(speaker => {
                fileData.legend[speaker] = speakersColors[speaker];
            });
        });
    }

    addRegions() {
        var self = this;

        self.currentRegions = [];

        self.filesData.forEach((fileData, fileIndex) => {
            let monologues = fileData.data;

            if (!monologues.length) return;

            var last_end = monologues[0].start;

            for (let i = 0, length = monologues.length; i < length; i++) {
                var monologue = monologues[i];

                var speakerId = '';
                if (monologue.speaker) {
                    speakerId = monologue.speaker.id.toString();
                }

                if (speakerId === constants.UNKNOWN_SPEAKER) {
                    speakerId = '';
                }

                var start = monologue.start;
                var end = monologue.end;


                // check overlapping with accuracy up to 5 decimal points
                // else if (last_end > start + 0.00001) {
                if (last_end > start + constants.TOLERANCE) {
                    console.error(`overlapping monologues. file index: ${fileIndex} time: ${last_end.toFixed(2)}`);
                }

                last_end = end;

                //region.element.innerText = speaker;
                const region = this.wavesurfer.addRegion({
                    start: start,
                    end: end,
                    data: {
                        initFinished: true,
                        fileIndex: fileIndex,
                        speaker: speakerId.split(constants.SPEAKERS_SEPARATOR).filter(x => x), //removing empty speaker
                        words: monologue.words.map((w) => {
                            return {
                                ...w,
                                uuid: uuidv4()
                            }
                        })
                    },
                    drag: false,
                    minLength: constants.MINIMUM_LENGTH
                });

                // if (speakerId === 'EDER') {
                //     region.color = monologue.speaker.color;
                // }

            }

            self.currentRegions.push(undefined);
        })

    }

    splitSegment() {
        let region = this.selectedRegion;
        if (!region) return;
        let time = this.wavesurfer.getCurrentTime();

        let first = copyRegion(region);
        let second = copyRegion(region);

        delete first.id;
        delete second.id;
        first.end = time;
        second.start = time;

        let words = JSON.parse(JSON.stringify(region.data.words));
        let i;
        for (i = 0, length = words.length; i < length; i++) {
            if (words[i].start > time) break;
        }

        first.data.words = words.slice(0, i);
        second.data.words = words.slice(i);

        this.__deleteRegion(region);
        first = this.wavesurfer.addRegion(first);
        second = this.wavesurfer.addRegion(second);

        //the list order matters!
        this.historyService.undoStack.push([first.id, second.id, region.id])
        this.historyService.regionsHistory[region.id].push(null);

        this.eventBus.trigger('geckoChanged', {
            event: 'splitSegment',
            data: [first.id, second.id, region.id]
        })

        this.$timeout(() => {
            this.setAllRegions()
            this.eventBus.trigger('rebuildProofReading', this.selectedRegion, this.selectedFileIndex)
        })
    }

    deleteRegionAction(region) {
        if (!region) return;

        this.historyService.undoStack.push([region.id]);
        this.historyService.regionsHistory[region.id].push(null);

        this.__deleteRegion(region);

        this.eventBus.trigger('geckoChanged', {
            event: 'deleteRegion',
            data: region
        })

        this.updateView();
    }

    __deleteRegion(region) {
        if (!region) return;

        if (region.data && region.data.isDummy) {
            this.dummyRegion = null
        }

        var prev = this.getRegion(region.prev);
        if (prev) prev.next = region.next;

        var next = this.getRegion(region.next);
        if (next) next.prev = region.prev;

        this.deselectRegion();
        region.remove();
    }

    setPlaybackSpeed(speed) {
        this.currentPlaybackSpeed = speed;
        this.wavesurfer.setPlaybackRate(speed);
    }

    playPause() {
        if (this.isPlaying) {
            this.wavesurfer.pause()
            this.videoPlayer && this.videoPlayer.pause()
        } else {
            this.wavesurfer.play()
            this.videoPlayer && this.videoPlayer.play()
        }
    }

    playRegion() {
        if (this.selectedRegion) {
            this.selectedRegion.play();
        }
        // play silence region
        else {
            var silence = this.calcSilenceRegion();
            this.wavesurfer.play(silence.start, silence.end);
        }
    }

    calcSilenceRegion() {
        var silence = {start: 0, end: null};
        var afterRegion = this.findClosestRegionToTime(this.selectedFileIndex, this.wavesurfer.getCurrentTime());
        var beforeRegion = this.findClosestRegionToTime(this.selectedFileIndex, this.wavesurfer.getCurrentTime(), true);

        if (afterRegion === null) {
            silence.end = this.wavesurfer.getDuration();
            if (beforeRegion !== null) {
                silence.start = beforeRegion.end;
            }
        } else {
            silence.end = afterRegion.start;
        }

        if (beforeRegion !== null) {
            silence.start = beforeRegion.end;
        }

        return silence;
    }

    toggleAutoCenter() {
        this.wavesurfer.params.autoCenter = !this.wavesurfer.params.autoCenter;
    }

    setCurrentTime() {
        // this.currentTimeSeconds = time;
        this.currentTime = secondsToMinutes(this.wavesurfer.getCurrentTime());
        this.$scope.$evalAsync();
    }

    async save(extension, converter) {
        try {
            await this.dataBase.clearDB()
        } catch (e) {
        }
        for (var i = 0; i < this.filesData.length; i++) {
            var current = this.filesData[i];
            if (current.data) {
                // convert the filename to "rttm" extension
                var filename = current.filename.substr(0, current.filename.lastIndexOf('.')) +'.' + extension;

                if (!this.checkValidRegions(i)) return;

                this.dataManager.downloadFileToClient(converter(i), filename);
            }
        }
    }

    async saveS3() {
        try {
            await this.dataBase.clearDB()
        } catch (e) {
        }
        const fileNameSpl = this.filesData[0].filename.split('.')
        const extension = fileNameSpl[fileNameSpl.length - 1]
        const converter = convertTextFormats(extension, this, config.parserOptions)
        for (var i = 0; i < this.filesData.length; i++) {
            var current = this.filesData[i];
            if (current.data) {
                var filename = current.filename.substr(0, current.filename.lastIndexOf('.')) + '.' + extension;

                if (!this.checkValidRegions(i)) return;
                try {
                    this.dataManager.saveDataToServer(converter(i), { filename, s3Subfolder: current.s3Subfolder });
                } catch (e) {

                }
            }
        }
    }

    saveDiscrepancyResults() {
        this.dataManager.downloadFileToClient(jsonStringify(this.discrepancies),
            this.filesData[0].filename + '_VS_' + this.filesData[1].filename + '.json');
    }

    saveClient(extension) {
        this.save(extension, convertTextFormats(extension, this, config.parserOptions))
    }

    checkValidRegions(fileIndex) {
        var self = this;
        try {
            var last_end = 0;
            this.iterateRegions((region) => {
                if (region.end <= region.start) {
                    throw `Negative duration in file ${self.filesData[fileIndex].filename}\n Start: ${region.start}\n End: ${region.end}`
                }

                if (last_end > region.start + constants.TOLERANCE) {
                    throw `Overlapping in file: ${self.filesData[fileIndex].filename}. \n Time: ${last_end.toFixed(2)}`;
                }
                last_end = region.end;
            }, fileIndex, true)
        } catch (err) {
            Swal.fire({
                icon: 'error',
                title: 'Check regions error',
                text: err
            })
            return false;
        }
        return true;
    }

    formatSpeaker(speaker) {
        var ret = ''

        if (speaker.length === 0) {
            ret = constants.UNKNOWN_SPEAKER;
        } else {
            ret = speaker.join(constants.SPEAKERS_SEPARATOR);
        }

        return ret;
    }

    speakerChanged(speaker) {
        var self = this;

        var speakers = self.selectedRegion.data.speaker;
        var idx = speakers.indexOf(speaker);

        // Is currently selected
        if (idx > -1) {
            speakers.splice(idx, 1);
        }

        // Is newly selected
        else {
            speakers.push(speaker);
        }

        this.historyService.addHistory(self.selectedRegion);
        this.historyService.undoStack.push([self.selectedRegion.id]);

        this.regionUpdated(self.selectedRegion);

        this.eventBus.trigger('geckoChanged', {
            event: 'speakerChanged',
            data: speaker
        })

        this.$timeout(() => {
            this.setAllRegions()
            this.eventBus.trigger('rebuildProofReading', this.selectedRegion, this.selectedFileIndex)
        })
    }

    speakerNameChanged(oldText, newText) {
        let self = this;

        // Check that there is no duplicate speaker.
        if (self.filesData[self.selectedFileIndex].legend[newText] !== undefined) return false;

        self.updateLegend(self.selectedFileIndex, oldText, newText);

        let changedRegions = [];
        self.iterateRegions(region => {
            let index = region.data.speaker.indexOf(oldText);

            if (index > -1) {
                region.data.speaker[index] = newText;
                this.historyService.addHistory(region);
                changedRegions.push(region.id);
            }
        }, self.selectedFileIndex);

        this.eventBus.trigger('geckoChanged', {
            event: 'speakerNameChanged',
            data: [self.selectedFileIndex, oldText, newText, changedRegions]
        })

        // notify the undo mechanism to change the legend as well as the regions
        this.historyService.undoStack.push([constants.SPEAKER_NAME_CHANGED_OPERATION_ID, self.selectedFileIndex, oldText, newText, changedRegions]);
    }

    updateLegend(fileIndex, oldSpeaker, newSpeaker) {
        let self = this;
        let fileData = self.filesData[fileIndex];

        fileData.legend[newSpeaker] = fileData.legend[oldSpeaker];
        delete fileData.legend[oldSpeaker];
        fileData.legend = sortLegend(fileData.legend);
    }

    newSpeakerKeyUp(e) {
        if (e.keyCode === 13) {
            this.addSpeaker();
        }
    }

    addSpeaker() {
        // var speakerNameElement = document.getElementById('newSpeakerName');

        let legend = this.filesData[this.selectedFileIndex].legend;

        if (this.newSpeakerName === '' || this.newSpeakerName in legend) return;

        // Add speaker to legend and assign random color
        const amountOfSpeakers = Object.keys(legend).length - Object.keys(constants.defaultSpeakers).length;

        legend[this.newSpeakerName] = constants.SPEAKER_COLORS[amountOfSpeakers];

        this.filesData[this.selectedFileIndex].legend = sortLegend(legend);

        this.newSpeakerName = '';
    }

// WARNING: Does not work well. after resize there's a dragging problem for regions
// resizeWavesurfer(e) {
//     var currentHeight = e.currentTarget.offsetHeight - 10;
//
//     if (this.previousHeight && currentHeight !== this.previousHeight) {
//         this.previousHeight = currentHeight;
//         this.wavesurfer.setHeight(currentHeight);
//     }
// }

    changeSpeakerColor(fileIndex, speaker, color) {
        var self = this;

        self.filesData[fileIndex].legend[speaker] = color;

        this.iterateRegions((region) => {
            if (region.data.speaker.indexOf(speaker) > -1) {
                //region.color = color;
                self.regionUpdated(region);
            }
        }, fileIndex);
    }

    loadServerMode(config) {
        var self = this;

        if (self.wavesurfer) self.wavesurfer.destroy();
        self.init();

        this.dataManager.loadFileFromServer(config).then((res) => {
            // var uint8buf = new Uint8Array(res.audioFile);
            // self.wavesurfer.loadBlob(new Blob([uint8buf]));
            self.wavesurfer.loadBlob(res.audioFile);
            self.audioFileName = res.audioFileName;
            res.segmentFiles.forEach(x => x.data = parseTextFormats(x.filename, x.data, this, config.parserOptions))
            self.filesData = res.segmentFiles;
        })
    }

    loadClientMode() {
        var self = this;
        var modalInstance = this.$uibModal.open(loadingModal(this));

        modalInstance.result.then((res) => {
            if (res) {
                if (self.wavesurfer) self.wavesurfer.destroy();
                self.init();
                parseAndLoadAudio(this, res);
            }
        });
    }

    async loadFromDB (res) {
        const mediaFile = res[0]
        const files = res[1]
        
        if (files && files.length) {
            this.filesData = files.map((f) => {
                return {
                    filename: f.fileName,
                    data: f.fileData
                }
            })
        } else {
            this.filesData = []
        }

        if (mediaFile) {
            this.audioFileName = mediaFile.fileName
            if (!mediaFile.isVideo) {
                this.wavesurfer.loadBlob(mediaFile.fileData)
            } else {
                const fileResult = await this.readVideoFile(mediaFile.fileData)
                this.videoPlayer = videojs('video-js')
                this.videoPlayer.ready(() => {
                    var fileUrl = URL.createObjectURL(mediaFile.fileData);
                    var fileType = mediaFile.fileData.type;
                    this.src({ type: fileType, src: fileUrl });
                    this.load();
                    this.muted(true)
                })
                this.wavesurfer.loadDecodedBuffer(fileResult)
            }
        }
    }

    handleTextFormats(filename, data) {
        return parseTextFormats(filename, data, this, config.parserOptions)
    }

    openShortcutsInfo() {
        this.$uibModal.open(shortcutsModal(this));
    }

    seek(time, leanTo) {
        let offset = 0;

        if (leanTo === 'right'){
            offset =  0.0001;
        }
        else if(leanTo === 'left'){
            offset = - 0.0001;
        }

        this.wavesurfer.seekTo((time + offset) / this.wavesurfer.getDuration());
    }

    editableKeysMapping(regionIndex, wordIndex, keys, which) {
        const currentRegion = this.currentRegions[regionIndex];
        const words = currentRegion.data.words;

        if (keys === 'space') {
            this.playPause()
        } else if (keys === 'ArrowRight') {
            let nextIndex = wordIndex + 1;
            if (nextIndex < words.length) {
                const nextWord = document.getElementById(`word_${regionIndex}_${nextIndex}`);
                nextWord.focus();
                // this.seek(words[nextIndex].start, 'right');
            } else {
                var nextRegion = this.getRegion(currentRegion.next);
                if (nextRegion) {
                    this.seek(nextRegion.data.words[0].start, 'right');
                    this.$timeout(() => {
                        const nextWord = document.getElementById(`word_${regionIndex}_0`)
                        if (nextWord) {
                            nextWord.focus()
                        }
                    })
                }
            }
        } else if (keys === 'ArrowLeft') {
            let prevIndex = wordIndex - 1
            if (prevIndex >= 0) {
                const prevWord = document.getElementById(`word_${regionIndex}_${prevIndex}`)
                prevWord.focus()
                // this.seek(words[prevIndex].start, 'right');
            } else {
                var prevRegion = this.getRegion(currentRegion.prev);
                if (prevRegion) {
                    const lastIndex = prevRegion.data.words.length - 1;
                    this.seek(prevRegion.data.words[lastIndex].start, 'right');
                    this.$timeout(() => {
                        const prevWord = document.getElementById(`word_${regionIndex}_${lastIndex}`)
                        if (prevWord) {
                            prevWord.focus()
                        }
                    })
                }
            }
        } else if (keys === 'alt_space') {
            this.playRegion()
        } else if (which === 219) {
            this.wavesurfer.skip(-5)
        }
    }

    toggleSpectrogram () {
        if (!this.spectrogramReady) {
            this.wavesurfer.initPlugin('spectrogram')
            this.spectrogramReady = true
        }
        this.showSpectrogram = !this.showSpectrogram
    }

    toggleProofReadingView () {
        this.proofReadingView = !this.proofReadingView
        if (!this.proofReadingView) {
            for (let i = 0; i < this.filesData.length; i++) {
                this.$timeout(() => this.eventBus.trigger('resetEditableWords', this.getCurrentRegion(i)))
            }
        } else {
            this.eventBus.trigger('proofReadingScrollToSelected')
        }
    }
}

MainController
    .$inject = ['$scope', '$uibModal', 'dataManager', 'dataBase', 'eventBus', 'discrepancyService', 'historyService', '$timeout','$interval'];
export {
    MainController
}