import { config } from './config.js'
import colorMap from './colormap'
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugin/wavesurfer.regions.min.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugin/wavesurfer.timeline.min.js';
import SpectrorgamPlugin from 'wavesurfer.js/dist/plugin/wavesurfer.spectrogram.min.js';

const debounce = (func, wait, immediate) => {
	var timeout;
	return () => {
		var context = this, args = arguments;
		var later = () => {
			timeout = null;
			if (!immediate) func.apply(context, args);
		};
		var callNow = immediate && !timeout;
		clearTimeout(timeout);
		timeout = setTimeout(later, wait);
		if (callNow) func.apply(context, args);
	};
};

export default (url) => {
    url = url || config.defaultUrl;
    var opts = config.wavesurfer;
    opts.plugins = [
		RegionsPlugin.create(),
		TimelinePlugin.create(
			{container:'#timeline'}
		)
	];

	if (opts.useSpectrogram) {
		opts.plugins.push(SpectrorgamPlugin.create({ container: '#wavespectrogram', colorMap, labels: true, deferInit: true }))
	}

    var wavesurfer = WaveSurfer.create(opts);

    return wavesurfer;
}
