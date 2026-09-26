/**
 * Pass.js — base class for post-processing passes, plus the full-screen quad
 * helper every pass uses to draw itself.
 *
 * Vendored to match Three.js r160. Imported by EffectComposer, RenderPass,
 * ShaderPass, MaskPass, UnrealBloomPass and OutputPass.
 */

import {
	Mesh,
	OrthographicCamera,
	BufferGeometry,
	Float32BufferAttribute
} from '../three.module.js';

class Pass {

	constructor() {

		this.isPass = true;
		this.enabled = true;
		this.needsSwap = true;
		this.clear = false;
		this.renderToScreen = false;

	}

	// Subclasses override this
	render() {}

	// Subclasses override this if they allocate size-dependent resources
	setSize() {}

	dispose() {}

}

const _camera = new OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

// A single full-screen triangle-pair, reused by every pass. Building the
// geometry once and reusing it across all passes avoids re-allocating a
// BufferGeometry on every resize.
class FullScreenQuad {

	constructor( material ) {

		this._mesh = new Mesh( _geometry, material );

	}

	get material() {

		return this._mesh.material;

	}

	set material( value ) {

		this._mesh.material = value;

	}

	render( renderer ) {

		renderer.render( this._mesh, _camera );

	}

	dispose() {

		this._mesh.geometry.dispose();

	}

}

// Shared unit quad. Cloned geometry is not needed because the full-screen
// quad never changes shape, only material.
const _geometry = new BufferGeometry();
_geometry.setAttribute( 'position', new Float32BufferAttribute( [ - 1, 3, 0, - 1, - 1, 0, 3, - 1, 0 ], 3 ) );
_geometry.setAttribute( 'uv', new Float32BufferAttribute( [ 0, 2, 0, 0, 2, 0 ], 2 ) );

export { Pass, FullScreenQuad };
