import { Box3, BufferGeometry, Group, Mesh, Vector3, type Object3D } from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIVERIES, buildCarBody, makeLiveryTexture, type CarStyleId } from './carMesh';

const STYLES: CarStyleId[] = ['p917', 'f512'];

function findByName(root: Object3D, name: string): Object3D | undefined {
  let found: Object3D | undefined;
  root.traverse((o) => {
    if (!found && o.name === name) found = o;
  });
  return found;
}

function everyGeometry(root: Object3D): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.isMesh && mesh.geometry) out.push(mesh.geometry as BufferGeometry);
  });
  return out;
}

describe('buildCarBody structure', () => {
  for (const style of STYLES) {
    it(`${style}: builds a group with body, canopy, chrome, wheels, chassis`, () => {
      const car = buildCarBody(style);
      try {
        expect(car.group).toBeInstanceOf(Group);
        expect(findByName(car.group, 'body')).toBeDefined();
        expect(findByName(car.group, 'canopy')).toBeDefined();
        expect(findByName(car.group, 'chrome')).toBeInstanceOf(Group);
        expect(findByName(car.group, 'chassis')).toBeDefined();
      } finally {
        car.dispose();
      }
    });

    it(`${style}: groups four wheels as front/rear pairs`, () => {
      const car = buildCarBody(style);
      try {
        expect(car.wheels.front).toBe(findByName(car.group, 'wheelFront'));
        expect(car.wheels.rear).toBe(findByName(car.group, 'wheelRear'));
        // Two wheels per axle group, four total.
        expect(car.wheels.front.children.length).toBe(2);
        expect(car.wheels.rear.children.length).toBe(2);
        let wheels = 0;
        car.group.traverse((o) => {
          if (o.name === 'wheel') wheels++;
        });
        expect(wheels).toBe(4);
      } finally {
        car.dispose();
      }
    });
  }
});

describe('buildCarBody geometry integrity', () => {
  for (const style of STYLES) {
    it(`${style}: every position and normal is finite (no NaN)`, () => {
      const car = buildCarBody(style);
      try {
        for (const geom of everyGeometry(car.group)) {
          const pos = geom.getAttribute('position');
          expect(pos).toBeDefined();
          expect(pos.count).toBeGreaterThan(0);
          for (let i = 0; i < pos.array.length; i++) {
            expect(Number.isFinite(pos.array[i])).toBe(true);
          }
          const nrm = geom.getAttribute('normal');
          if (nrm) {
            for (let i = 0; i < nrm.array.length; i++) {
              expect(Number.isFinite(nrm.array[i])).toBe(true);
            }
          }
        }
      } finally {
        car.dispose();
      }
    });

    it(`${style}: bounding box is a low-wide AFX footprint sitting on y≈0`, () => {
      const car = buildCarBody(style);
      try {
        car.group.updateMatrixWorld(true);
        const box = new Box3().setFromObject(car.group);
        const size = box.getSize(new Vector3());
        expect(size.x).toBeLessThan(0.08); // length
        expect(size.z).toBeLessThan(0.032); // width
        expect(size.y).toBeLessThan(0.022); // height
        // Low + wide, not a cube: clearly longer than tall and wider than tall.
        expect(size.x).toBeGreaterThan(size.y * 2.5);
        expect(size.z).toBeGreaterThan(size.y);
        // Rests on the ground plane: only the guide-pin shoe dips below y=0.
        expect(Math.abs(box.min.y)).toBeLessThan(0.003);
      } finally {
        car.dispose();
      }
    });
  }
});

describe('buildCarBody disposal', () => {
  it('dispose() releases every geometry without throwing, idempotently', () => {
    const car = buildCarBody('p917');
    const geoms = everyGeometry(car.group);
    expect(geoms.length).toBeGreaterThan(0);
    let disposed = 0;
    for (const g of geoms) {
      const original = g.dispose.bind(g);
      g.dispose = () => {
        disposed++;
        original();
      };
    }
    expect(() => car.dispose()).not.toThrow();
    expect(disposed).toBe(geoms.length);
    expect(() => car.dispose()).not.toThrow();
  });
});

// The livery paint map needs a 2D canvas, which the node test env lacks. A
// minimal recording stub lets us drive the real texture path and prove the two
// styles produce distinct, non-shared paint maps with the right base colors.
interface FakeCanvas {
  width: number;
  height: number;
  _fills: { style: string }[];
  getContext(kind: string): unknown;
}

describe('livery paint maps differ between styles (not shared)', () => {
  let saved: unknown;

  beforeAll(() => {
    saved = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {
      createElement(tag: string) {
        if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
        const canvas: FakeCanvas = {
          width: 0,
          height: 0,
          _fills: [],
          getContext() {
            const ctx = {
              fillStyle: '',
              font: '',
              textAlign: '',
              textBaseline: '',
              fillRect() {
                canvas._fills.push({ style: ctx.fillStyle });
              },
              beginPath() {},
              arc() {},
              fill() {
                canvas._fills.push({ style: ctx.fillStyle });
              },
              stroke() {},
              fillText() {},
              save() {},
              restore() {},
              translate() {},
              rotate() {},
              scale() {},
            };
            return ctx;
          },
        };
        return canvas;
      },
    };
  });

  afterAll(() => {
    (globalThis as { document?: unknown }).document = saved;
  });

  it('generates a distinct canvas + texture per style with the spec base colors', () => {
    const a = makeLiveryTexture('p917');
    const b = makeLiveryTexture('f512');
    expect(a.texture).not.toBeNull();
    expect(b.texture).not.toBeNull();
    expect(a.texture).not.toBe(b.texture);
    expect(a.texture!.image).not.toBe(b.texture!.image);

    const baseA = (a.texture!.image as FakeCanvas)._fills[0]!.style;
    const baseB = (b.texture!.image as FakeCanvas)._fills[0]!.style;
    expect(baseA).toBe(LIVERIES.p917.base);
    expect(baseB).toBe(LIVERIES.f512.base);
    expect(baseA).not.toBe(baseB);
  });

  it('gives each built car its own paint map instance', () => {
    const a = buildCarBody('p917');
    const b = buildCarBody('f512');
    try {
      const matA = (findByName(a.group, 'body') as Mesh).material as { map: unknown };
      const matB = (findByName(b.group, 'body') as Mesh).material as { map: unknown };
      expect(matA.map).not.toBeNull();
      expect(matB.map).not.toBeNull();
      expect(matA.map).not.toBe(matB.map);
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('distinguishes the two liveries by number', () => {
    expect(LIVERIES.p917.number).not.toBe(LIVERIES.f512.number);
  });
});
