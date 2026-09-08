//! Server-authoritative dice geometry and offline rigid-body replays.
//!
//! Coordinates are Y-up; the playable table is x = ±3.2, z = ±4.8, y = 0.
//! Quaternions are serialized in Three.js-compatible XYZW order. A d4 reports
//! its **downward** face (the face against the table), not an upward face. The
//! UI should show that result separately rather than put one number at each
//! triangular face's center and read the top. Kind 100 is the *tens mesh*, with
//! face labels 0, 10, …, 90; a percentile simulation also includes a units d10.

use std::{f32::consts::TAU, sync::OnceLock};

use anyhow::{Context, Result, bail, ensure};
use rand::Rng;
use rapier3d::{
    na::{Quaternion, UnitQuaternion},
    prelude::*,
};
use serde::{Deserialize, Serialize};

const RADIUS: f32 = 0.62;
const HALF_X: f32 = 3.2;
const HALF_Z: f32 = 4.8;
const WALL_HEIGHT: f32 = 2.5;
const HZ: u32 = 120;
const SAMPLE_EVERY: u32 = 4;
const NORMAL_STEPS: u32 = 10 * HZ;
const MAX_STEPS: u32 = 15 * HZ;
const FACE_ALIGNMENT: f32 = 0.999;

#[derive(Serialize, Clone, Debug)]
pub struct DieGeometry {
    pub kind: u16,
    pub vertices: Vec<[f32; 3]>,
    pub faces: Vec<DieFace>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DieFace {
    /// Counterclockwise when viewed from outside the solid.
    pub indices: Vec<usize>,
    pub normal: [f32; 3],
    pub value: u16,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Swipe {
    /// Normalized screen coordinates, positive Y down (positive world Z).
    pub start: [f32; 2],
    /// Displacement divided by the table's short dimension, not a unit vector.
    pub delta: [f32; 2],
    pub duration_ms: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Simulation {
    pub duration_ms: u32,
    pub tracks: Vec<Track>,
    pub value: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Track {
    pub kind: u16,
    pub value: u16,
    pub frames: Vec<Frame>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Frame {
    pub t: u32,
    pub p: [f32; 3],
    /// Quaternion components [x, y, z, w].
    pub q: [f32; 4],
}

/// The very same convex hulls used by the simulation, with polygonal faces.
/// Triangulate a face as a fan for rendering; its normal and value belong to
/// the entire polygon, not each triangle.
pub fn catalog() -> Vec<DieGeometry> {
    geometries().to_vec()
}

/// Run a bounded, fixed-step simulation without sleeping the server thread.
/// Call from a blocking worker, not directly on an async executor. Randomness
/// comes exclusively from the server; no client-provided seed determines a roll.
pub fn simulate(die: u16, swipe: Swipe) -> Result<Simulation> {
    simulate_with_rng(die, swipe, &mut rand::thread_rng())
}

fn geometries() -> &'static [DieGeometry] {
    static CATALOG: OnceLock<Vec<DieGeometry>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let tetrahedron = vec![
            vector![1.0, 1.0, 1.0],
            vector![1.0, -1.0, -1.0],
            vector![-1.0, 1.0, -1.0],
            vector![-1.0, -1.0, 1.0],
        ];
        let mut cube = Vec::new();
        for x in [-1.0, 1.0] {
            for y in [-1.0, 1.0] {
                for z in [-1.0, 1.0] {
                    cube.push(vector![x, y, z]);
                }
            }
        }
        let octahedron = vec![
            vector![1.0, 0.0, 0.0],
            vector![-1.0, 0.0, 0.0],
            vector![0.0, 1.0, 0.0],
            vector![0.0, -1.0, 0.0],
            vector![0.0, 0.0, 1.0],
            vector![0.0, 0.0, -1.0],
        ];
        let phi = (1.0 + 5.0_f32.sqrt()) / 2.0;
        let mut icosahedron = Vec::new();
        for a in [-1.0, 1.0] {
            for b in [-phi, phi] {
                icosahedron.extend([vector![0.0, a, b], vector![a, b, 0.0], vector![b, 0.0, a]]);
            }
        }
        // Polar duality gives an actual regular dodecahedron, with 12
        // pentagonal faces rather than a collection of labeled triangles.
        let dodecahedron = polar_dual(&icosahedron);

        // The polar dual of a pentagonal antiprism is a pentagonal
        // trapezohedron: two poles, ten staggered equatorial vertices and ten
        // congruent planar kite faces. The antiprism half-height controls the
        // d10's aspect ratio; 0.9 gives a practical, almost cospherical die.
        let mut antiprism = Vec::new();
        for layer in 0..2 {
            for i in 0..5 {
                let angle = (i as f32 + layer as f32 * 0.5) * TAU / 5.0;
                antiprism.push(vector![
                    angle.cos(),
                    if layer == 0 { 0.9 } else { -0.9 },
                    angle.sin()
                ]);
            }
        }
        let trapezohedron = polar_dual(&antiprism);
        vec![
            make_geometry(4, tetrahedron),
            make_geometry(6, cube),
            make_geometry(8, octahedron),
            make_geometry(10, trapezohedron.clone()),
            make_geometry(12, dodecahedron),
            make_geometry(20, icosahedron),
            make_geometry(100, trapezohedron),
        ]
    })
}

fn polar_dual(vertices: &[Vector<f32>]) -> Vec<Vector<f32>> {
    supporting_faces(vertices)
        .iter()
        .map(|face| {
            let normal = Vector::from(face.normal);
            normal / normal.dot(&vertices[face.indices[0]])
        })
        .collect()
}

fn make_geometry(kind: u16, mut vertices: Vec<Vector<f32>>) -> DieGeometry {
    let radius = vertices.iter().map(Vector::norm).fold(0.0_f32, f32::max);
    for vertex in &mut vertices {
        *vertex *= RADIUS / radius;
    }
    let mut faces = supporting_faces(&vertices);
    let sides = if kind == 100 { 10 } else { kind };
    assert_eq!(faces.len(), sides as usize, "invalid d{kind} hull");

    if kind == 4 {
        for (i, face) in faces.iter_mut().enumerate() {
            face.value = i as u16 + 1;
        }
    } else {
        // All these even-faced hulls are centrally symmetric. Assign
        // complementary labels to actual opposite faces, not mesh indices.
        let mut assigned = vec![false; faces.len()];
        let mut next = 1;
        for i in 0..faces.len() {
            if assigned[i] {
                continue;
            }
            let normal = Vector::from(faces[i].normal);
            let opposite = (0..faces.len())
                .filter(|&j| j != i && !assigned[j])
                .min_by(|&a, &b| {
                    normal
                        .dot(&Vector::from(faces[a].normal))
                        .total_cmp(&normal.dot(&Vector::from(faces[b].normal)))
                })
                .expect("opposite face");
            assert!(normal.dot(&Vector::from(faces[opposite].normal)) < -0.9999);
            faces[i].value = next;
            faces[opposite].value = sides + 1 - next;
            assigned[i] = true;
            assigned[opposite] = true;
            next += 1;
        }
        if kind == 100 {
            for face in &mut faces {
                face.value = (face.value - 1) * 10;
            }
        }
    }
    DieGeometry {
        kind,
        vertices: vertices.into_iter().map(Into::into).collect(),
        faces,
    }
}

/// Enumerate supporting planes of these small hulls, merging all coplanar
/// triples into a single polygon. This avoids coupling render face labels to
/// whichever triangulation a collision-hull implementation happens to choose.
fn supporting_faces(vertices: &[Vector<f32>]) -> Vec<DieFace> {
    const EPS: f32 = 0.00002;
    let mut faces = Vec::new();
    let mut keys = Vec::new();
    for i in 0..vertices.len() {
        for j in i + 1..vertices.len() {
            for k in j + 1..vertices.len() {
                let cross = (vertices[j] - vertices[i]).cross(&(vertices[k] - vertices[i]));
                if cross.norm_squared() < 1e-12 {
                    continue;
                }
                let mut normal = cross.normalize();
                let distances: Vec<_> = vertices
                    .iter()
                    .map(|v| normal.dot(&(v - vertices[i])))
                    .collect();
                let positive = distances.iter().any(|&d| d > EPS);
                let negative = distances.iter().any(|&d| d < -EPS);
                if positive && negative {
                    continue;
                }
                if positive {
                    normal = -normal;
                }
                let mut indices: Vec<_> = distances
                    .iter()
                    .enumerate()
                    .filter_map(|(index, d)| (d.abs() <= EPS).then_some(index))
                    .collect();
                if keys.contains(&indices) {
                    continue;
                }
                keys.push(indices.clone());
                let center = indices.iter().map(|&n| vertices[n]).sum::<Vector<f32>>()
                    / indices.len() as f32;
                let u = (vertices[indices[0]] - center).normalize();
                let v = normal.cross(&u);
                indices.sort_by(|&a, &b| {
                    let a = vertices[a] - center;
                    let b = vertices[b] - center;
                    a.dot(&v)
                        .atan2(a.dot(&u))
                        .total_cmp(&b.dot(&v).atan2(b.dot(&u)))
                });
                faces.push(DieFace {
                    indices,
                    normal: normal.into(),
                    value: 0,
                });
            }
        }
    }
    faces
}

struct World {
    pipeline: PhysicsPipeline,
    parameters: IntegrationParameters,
    islands: IslandManager,
    broad_phase: BroadPhaseMultiSap,
    narrow_phase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    ccd_solver: CCDSolver,
}

impl World {
    fn new() -> Self {
        let mut world = Self {
            pipeline: PhysicsPipeline::new(),
            parameters: IntegrationParameters {
                dt: 1.0 / HZ as f32,
                max_ccd_substeps: 4,
                contact_natural_frequency: 120.0,
                // Include fast-spinning corners in predictive contacts, not
                // only the center-of-mass sweep used by soft CCD.
                normalized_prediction_distance: 0.15,
                ..IntegrationParameters::default()
            },
            islands: IslandManager::new(),
            broad_phase: BroadPhaseMultiSap::new(),
            narrow_phase: NarrowPhase::new(),
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            ccd_solver: CCDSolver::new(),
        };
        let thickness = 0.25;
        // Boxes overlap at the corners. Their INNER planes are the table
        // bounds; an invisible ceiling prevents high-speed wall escapes.
        for (half_extents, center) in [
            (
                vector![HALF_X + thickness, thickness, HALF_Z + thickness],
                vector![0.0, -thickness, 0.0],
            ),
            (
                vector![HALF_X + thickness, thickness, HALF_Z + thickness],
                vector![0.0, WALL_HEIGHT + thickness, 0.0],
            ),
            (
                vector![thickness, WALL_HEIGHT / 2.0, HALF_Z + thickness],
                vector![-HALF_X - thickness, WALL_HEIGHT / 2.0, 0.0],
            ),
            (
                vector![thickness, WALL_HEIGHT / 2.0, HALF_Z + thickness],
                vector![HALF_X + thickness, WALL_HEIGHT / 2.0, 0.0],
            ),
            (
                vector![HALF_X + thickness, WALL_HEIGHT / 2.0, thickness],
                vector![0.0, WALL_HEIGHT / 2.0, -HALF_Z - thickness],
            ),
            (
                vector![HALF_X + thickness, WALL_HEIGHT / 2.0, thickness],
                vector![0.0, WALL_HEIGHT / 2.0, HALF_Z + thickness],
            ),
        ] {
            world.colliders.insert(
                ColliderBuilder::cuboid(half_extents.x, half_extents.y, half_extents.z)
                    .translation(center)
                    .friction(0.75)
                    .restitution(0.2)
                    .build(),
            );
        }
        world
    }

    fn add_die(
        &mut self,
        geometry: &DieGeometry,
        position: Isometry<f32>,
        velocity: Vector<f32>,
        spin: Vector<f32>,
    ) -> Result<RigidBodyHandle> {
        let points: Vec<_> = geometry.vertices.iter().map(|v| Point::from(*v)).collect();
        let collider = ColliderBuilder::convex_hull(&points)
            .context("could not construct die collision hull")?
            .density(1.0)
            .friction(0.7)
            .restitution(0.3)
            .build();
        let mut body = RigidBodyBuilder::dynamic()
            .position(position)
            .linvel(velocity)
            .angvel(spin)
            .linear_damping(0.22)
            .angular_damping(0.3)
            .additional_solver_iterations(4)
            .ccd_enabled(true)
            .build();
        // Defaults permit visible drift. Require genuinely small velocities
        // for half a second, and let Rapier (not this module) put bodies asleep.
        let activation = body.activation_mut();
        activation.normalized_linear_threshold = 0.025;
        activation.angular_threshold = 0.06;
        activation.time_until_sleep = 0.5;
        let handle = self.bodies.insert(body);
        self.colliders
            .insert_with_parent(collider, handle, &mut self.bodies);
        Ok(handle)
    }

    fn step(&mut self) {
        self.pipeline.step(
            &vector![0.0, -9.81, 0.0],
            &self.parameters,
            &mut self.islands,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.bodies,
            &mut self.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            &mut self.ccd_solver,
            None,
            &(),
            &(),
        );
    }
}

fn launch(swipe: &Swipe, paired: bool) -> Result<(Vector<f32>, Vector<f32>)> {
    ensure!(
        swipe
            .start
            .iter()
            .chain(swipe.delta.iter())
            .chain([&swipe.duration_ms])
            .all(|v| v.is_finite()),
        "swipe must contain only finite numbers"
    );
    let seconds = swipe.duration_ms.clamp(60.0, 1200.0) / 1000.0;
    // Clamp BEFORE arithmetic so even finite f32::MAX cannot overflow.
    let mut velocity = vector![
        swipe.delta[0].clamp(-4.0, 4.0) * (HALF_X * 2.0) * 0.5 / seconds,
        0.0,
        swipe.delta[1].clamp(-4.0, 4.0) * (HALF_X * 2.0) * 0.5 / seconds,
    ];
    let speed = velocity.norm();
    if speed > 11.0 {
        velocity *= 11.0 / speed;
    }
    velocity.y = 2.0 + velocity.norm() * 0.12;
    let pair_offset = if paired { 0.68 } else { 0.0 };
    let position = vector![
        swipe.start[0].clamp(-1.0, 1.0) * (HALF_X - RADIUS - 0.12 - pair_offset),
        1.15,
        swipe.start[1].clamp(-1.0, 1.0) * (HALF_Z - RADIUS - 0.12),
    ];
    Ok((position, velocity))
}

fn random_rotation(rng: &mut impl Rng) -> UnitQuaternion<f32> {
    // Uniform on SO(3), unlike independent uniform Euler angles.
    let u: f32 = rng.r#gen();
    let a: f32 = rng.gen_range(0.0..TAU);
    let b: f32 = rng.gen_range(0.0..TAU);
    let small = (1.0 - u).sqrt();
    let large = u.sqrt();
    UnitQuaternion::new_normalize(Quaternion::new(
        large * b.cos(),
        small * a.sin(),
        small * a.cos(),
        large * b.sin(),
    ))
}

fn simulate_with_rng(die: u16, swipe: Swipe, rng: &mut impl Rng) -> Result<Simulation> {
    let main = geometries()
        .iter()
        .find(|g| g.kind == die)
        .with_context(|| format!("unsupported die: d{die}"))?;
    let mut geometry = vec![main];
    if die == 100 {
        geometry.push(
            geometries()
                .iter()
                .find(|g| g.kind == 10)
                .expect("d10 catalog"),
        );
    }
    let (start, velocity) = launch(&swipe, die == 100)?;
    let mut world = World::new();
    let mut handles = Vec::new();
    let mut tracks = Vec::new();
    for (index, mesh) in geometry.iter().enumerate() {
        let offset = if die == 100 {
            if index == 0 { -0.68 } else { 0.68 }
        } else {
            0.0
        };
        let position = Isometry::from_parts(
            (start + vector![offset, 0.0, 0.0]).into(),
            random_rotation(rng),
        );
        let spin = vector![
            rng.gen_range(-13.0..13.0) + velocity.z * 0.5,
            rng.gen_range(-13.0..13.0),
            rng.gen_range(-13.0..13.0) - velocity.x * 0.5,
        ];
        handles.push(world.add_die(mesh, position, velocity, spin)?);
        tracks.push(Track {
            kind: mesh.kind,
            value: 0,
            frames: Vec::with_capacity(240),
        });
    }
    record(&mut tracks, &world.bodies, &handles, 0);
    let mut next_nudge = vec![HZ; handles.len()];
    let mut slow_cocked_steps = vec![0; handles.len()];
    let mut deadline = NORMAL_STEPS;
    for step in 1..=MAX_STEPS {
        world.step();
        let mut all_settled = true;
        for (index, &handle) in handles.iter().enumerate() {
            let body = &mut world.bodies[handle];
            ensure!(
                body.position()
                    .to_homogeneous()
                    .iter()
                    .all(|v| v.is_finite())
                    && body
                        .linvel()
                        .iter()
                        .chain(body.angvel().iter())
                        .all(|v| v.is_finite()),
                "dice simulation produced a non-finite state"
            );
            let readable = resting_face(geometry[index], body).is_some();
            if body.is_sleeping() && readable {
                continue;
            }
            all_settled = false;
            // A cocked body can also rock slowly against a wall forever
            // without quite reaching Rapier's sleep thresholds. Require a
            // sustained low-energy, unreadable pose before disturbing it.
            if !readable
                && body.translation().y < RADIUS + 0.1
                && body.linvel().norm_squared() < 0.04
                && body.angvel().norm_squared() < 0.36
            {
                slow_cocked_steps[index] += 1;
            } else {
                slow_cocked_steps[index] = 0;
            }
            if (body.is_sleeping() || slow_cocked_steps[index] >= HZ / 2)
                && step >= next_nudge[index]
            {
                // A wall lean, edge/corner balance, or die stacked on another
                // is cocked. Apply a small physical impulse; NEVER rotate to
                // a chosen answer, teleport, or freeze a still-moving body.
                nudge(body, rng);
                next_nudge[index] = step + HZ;
                slow_cocked_steps[index] = 0;
                deadline = MAX_STEPS;
            }
        }
        if all_settled {
            record(&mut tracks, &world.bodies, &handles, step);
            for (index, track) in tracks.iter_mut().enumerate() {
                track.value = resting_face(geometry[index], &world.bodies[handles[index]])
                    .context("settled die has no unambiguous result")?;
            }
            let value = if die == 100 {
                percentile(tracks[0].value, tracks[1].value)
            } else {
                tracks[0].value
            };
            return Ok(Simulation {
                duration_ms: time_ms(step),
                tracks,
                value,
            });
        }
        if step % SAMPLE_EVERY == 0 {
            record(&mut tracks, &world.bodies, &handles, step);
        }
        if step >= deadline {
            break;
        }
    }
    bail!(
        "dice did not settle on readable faces within {} seconds; roll again",
        deadline / HZ
    )
}

fn nudge(body: &mut RigidBody, rng: &mut impl Rng) {
    let p = body.translation();
    let away_x = if p.x.abs() > HALF_X - 0.9 {
        -p.x.signum() * 0.8
    } else {
        0.0
    };
    let away_z = if p.z.abs() > HALF_Z - 0.9 {
        -p.z.signum() * 0.8
    } else {
        0.0
    };
    let mass = body.mass();
    body.apply_impulse(
        mass * vector![
            away_x + rng.gen_range(-0.5..0.5),
            rng.gen_range(1.0..1.5),
            away_z + rng.gen_range(-0.5..0.5),
        ],
        true,
    );
    body.apply_torque_impulse(
        mass * vector![
            rng.gen_range(-0.15..0.15),
            rng.gen_range(-0.15..0.15),
            rng.gen_range(-0.15..0.15),
        ],
        true,
    );
}

fn resting_face(geometry: &DieGeometry, body: &RigidBody) -> Option<u16> {
    let sign = if geometry.kind == 4 { -1.0 } else { 1.0 };
    let (face, alignment) = geometry
        .faces
        .iter()
        .map(|face| {
            let world_normal = body.rotation() * Vector::from(face.normal);
            (face, sign * world_normal.y)
        })
        .max_by(|a, b| a.1.total_cmp(&b.1))?;
    if alignment < FACE_ALIGNMENT {
        return None;
    }
    let mut lowest = f32::INFINITY;
    for vertex in &geometry.vertices {
        let p = body.position() * Point::from(*vertex);
        // A floor-aligned die resting on another die is still cocked. Check
        // the complete hull, not just the center or its bounding sphere.
        if p.x.abs() > HALF_X + 0.015 || p.z.abs() > HALF_Z + 0.015 || p.y > WALL_HEIGHT + 0.015 {
            return None;
        }
        lowest = lowest.min(p.y);
    }
    if !(-0.015..=0.025).contains(&lowest) {
        return None;
    }
    Some(face.value)
}

fn percentile(tens: u16, units: u16) -> u16 {
    let value = tens + units % 10;
    if value == 0 { 100 } else { value }
}

fn time_ms(step: u32) -> u32 {
    (step * 1000 + HZ / 2) / HZ
}

fn record(tracks: &mut [Track], bodies: &RigidBodySet, handles: &[RigidBodyHandle], step: u32) {
    let t = time_ms(step);
    for (track, &handle) in tracks.iter_mut().zip(handles) {
        if track.frames.last().is_some_and(|f| f.t == t) {
            continue;
        }
        let body = &bodies[handle];
        let q = body.rotation().quaternion();
        track.frames.push(Frame {
            t,
            p: (*body.translation()).into(),
            q: [q.i, q.j, q.k, q.w],
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{SeedableRng, rngs::StdRng};
    use std::collections::{BTreeMap, BTreeSet};

    fn swipe() -> Swipe {
        Swipe {
            start: [-0.4, 0.65],
            delta: [0.4, -0.9],
            duration_ms: 280.0,
        }
    }

    fn pose(frame: &Frame) -> Isometry<f32> {
        Isometry::from_parts(
            Vector::from(frame.p).into(),
            UnitQuaternion::new_normalize(Quaternion::new(
                frame.q[3], frame.q[0], frame.q[1], frame.q[2],
            )),
        )
    }

    fn assert_replay(simulation: &Simulation, kind: u16) {
        assert!((1..=15_000).contains(&simulation.duration_ms));
        assert!((1..=kind).contains(&simulation.value));
        assert_eq!(simulation.tracks.len(), if kind == 100 { 2 } else { 1 });
        for track in &simulation.tracks {
            let mesh = geometries().iter().find(|g| g.kind == track.kind).unwrap();
            assert_eq!(track.frames.first().unwrap().t, 0);
            assert_eq!(track.frames.last().unwrap().t, simulation.duration_ms);
            assert!(track.frames.len() > 15);
            assert!(
                track
                    .frames
                    .windows(2)
                    .all(|w| w[0].t < w[1].t && w[1].t - w[0].t <= 34)
            );
            assert!(mesh.faces.iter().any(|f| f.value == track.value));
            for frame in &track.frames {
                assert!(frame.p.iter().chain(frame.q.iter()).all(|v| v.is_finite()));
                assert!((frame.q.iter().map(|v| v * v).sum::<f32>() - 1.0).abs() < 0.0001);
                for vertex in &mesh.vertices {
                    let p = pose(frame) * Point::from(*vertex);
                    // Allow small contact-solver penetration, not escaped dice.
                    assert!(
                        p.x.abs() <= HALF_X + 0.04,
                        "d{} x escaped at {} ms: {p:?}",
                        track.kind,
                        frame.t
                    );
                    assert!(
                        p.z.abs() <= HALF_Z + 0.04,
                        "d{} z escaped at {} ms: {p:?}",
                        track.kind,
                        frame.t
                    );
                    assert!(
                        (-0.04..=WALL_HEIGHT + 0.04).contains(&p.y),
                        "d{} y escaped at {} ms: {p:?}",
                        track.kind,
                        frame.t
                    );
                }
            }
            let final_body = RigidBodyBuilder::dynamic()
                .position(pose(track.frames.last().unwrap()))
                .build();
            assert_eq!(resting_face(mesh, &final_body), Some(track.value));
            // The last half-second is physically at rest, not an arbitrary
            // final pose appended after cutting off a moving trajectory.
            let final_frame = track.frames.last().unwrap();
            let earlier = track
                .frames
                .iter()
                .rev()
                .find(|f| f.t + 250 <= final_frame.t)
                .unwrap();
            assert!((Vector::from(earlier.p) - Vector::from(final_frame.p)).norm() < 0.025);
            assert!(pose(earlier).rotation.angle_to(&pose(final_frame).rotation) < 0.04);
        }
        if kind == 100 {
            assert_eq!(simulation.tracks[0].kind, 100);
            assert_eq!(simulation.tracks[1].kind, 10);
            assert_eq!(
                simulation.value,
                percentile(simulation.tracks[0].value, simulation.tracks[1].value)
            );
            assert_eq!(
                simulation.tracks[0]
                    .frames
                    .iter()
                    .map(|f| f.t)
                    .collect::<Vec<_>>(),
                simulation.tracks[1]
                    .frames
                    .iter()
                    .map(|f| f.t)
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn catalog_has_real_polyhedra_and_outward_polygon_faces() {
        let expected = [
            (4, 4, 4, 3),
            (6, 8, 6, 4),
            (8, 6, 8, 3),
            (10, 12, 10, 4),
            (12, 20, 12, 5),
            (20, 12, 20, 3),
            (100, 12, 10, 4),
        ];
        let catalog = catalog();
        assert_eq!(catalog.len(), expected.len());
        for (mesh, (kind, vertices, faces, corners)) in catalog.iter().zip(expected) {
            assert_eq!(mesh.kind, kind);
            assert_eq!(mesh.vertices.len(), vertices);
            assert_eq!(mesh.faces.len(), faces);
            let mut edges = BTreeMap::new();
            let mut edge_lengths = Vec::new();
            for vertex in &mesh.vertices {
                assert!(vertex.iter().all(|v| v.is_finite()));
                assert!(Vector::from(*vertex).norm() <= RADIUS + 0.00001);
            }
            for face in &mesh.faces {
                assert_eq!(face.indices.len(), corners);
                let normal = Vector::from(face.normal);
                assert!(normal.iter().all(|v| v.is_finite()));
                assert!((normal.norm() - 1.0).abs() < 0.00001);
                let a = Vector::from(mesh.vertices[face.indices[0]]);
                let d = normal.dot(&a);
                assert!(d > 0.0);
                for vertex in &mesh.vertices {
                    assert!(normal.dot(&Vector::from(*vertex)) <= d + 0.00002);
                }
                for i in 0..corners {
                    let ia = face.indices[i];
                    let ib = face.indices[(i + 1) % corners];
                    let ic = face.indices[(i + 2) % corners];
                    let a = Vector::from(mesh.vertices[ia]);
                    let b = Vector::from(mesh.vertices[ib]);
                    let c = Vector::from(mesh.vertices[ic]);
                    assert!((normal.dot(&a) - d).abs() < 0.00002, "nonplanar face");
                    assert!((b - a).cross(&(c - b)).dot(&normal) > 0.0, "inward winding");
                    *edges.entry((ia.min(ib), ia.max(ib))).or_insert(0) += 1;
                    edge_lengths.push((b - a).norm());
                }
                if kind != 4 {
                    let opposite = mesh
                        .faces
                        .iter()
                        .find(|f| normal.dot(&Vector::from(f.normal)) < -0.9999)
                        .unwrap();
                    assert_eq!(
                        face.value + opposite.value,
                        if kind == 100 { 90 } else { kind + 1 }
                    );
                }
            }
            assert!(edges.values().all(|&count| count == 2));
            assert_eq!(vertices + faces, edges.len() + 2, "Euler characteristic");
            if kind != 10 && kind != 100 {
                let length = edge_lengths[0];
                assert!(
                    edge_lengths.iter().all(|l| (l - length).abs() < 0.00002),
                    "not regular"
                );
                assert!(
                    mesh.vertices
                        .iter()
                        .all(|v| (Vector::from(*v).norm() - RADIUS).abs() < 0.00002)
                );
            }
            let labels: BTreeSet<_> = mesh.faces.iter().map(|f| f.value).collect();
            let expected_labels = if kind == 100 {
                (0..10).map(|v| v * 10).collect()
            } else {
                (1..=kind).collect()
            };
            assert_eq!(labels, expected_labels);
        }
    }

    #[test]
    fn all_die_kinds_produce_aligned_bounded_replays() {
        for kind in [4, 6, 8, 10, 12, 20, 100] {
            for seed in [7, 42, 2026] {
                let simulation = simulate_with_rng(kind, swipe(), &mut StdRng::seed_from_u64(seed))
                    .unwrap_or_else(|e| panic!("d{kind}, seed {seed}: {e}"));
                assert_replay(&simulation, kind);
            }
        }
    }

    #[test]
    fn extreme_and_zero_swipes_remain_bounded() {
        for (index, swipe) in [
            Swipe {
                start: [1.0, 1.0],
                delta: [4.0, 4.0],
                duration_ms: 60.0,
            },
            Swipe {
                start: [-1.0, -1.0],
                delta: [-4.0, -4.0],
                duration_ms: 60.0,
            },
            Swipe {
                start: [0.0, 0.0],
                delta: [0.0, 0.0],
                duration_ms: 1200.0,
            },
            Swipe {
                start: [f32::MAX, -f32::MAX],
                delta: [f32::MAX, f32::MAX],
                duration_ms: -f32::MAX,
            },
        ]
        .into_iter()
        .enumerate()
        {
            let simulation =
                simulate_with_rng(100, swipe, &mut StdRng::seed_from_u64(index as u64)).unwrap();
            assert_replay(&simulation, 100);
        }
    }

    #[test]
    fn launch_respects_screen_axes_speed_start_and_duration_bounds() {
        let input = Swipe {
            start: [0.5, -0.5],
            delta: [0.05, -0.1],
            duration_ms: 600.0,
        };
        let (p, v) = launch(&input, false).unwrap();
        assert!(p.x > 0.0 && p.z < 0.0 && v.x > 0.0 && v.z < 0.0);
        let (_, fast) = launch(
            &Swipe {
                duration_ms: 300.0,
                ..input.clone()
            },
            false,
        )
        .unwrap();
        assert!((fast.x - v.x * 2.0).abs() < 0.00001);
        assert!((fast.z - v.z * 2.0).abs() < 0.00001);
        assert!(fast.y > v.y);
        let (opposite_p, opposite_v) = launch(
            &Swipe {
                start: [-0.5, 0.5],
                delta: [-0.05, 0.1],
                ..input.clone()
            },
            false,
        )
        .unwrap();
        assert_eq!(p.x, -opposite_p.x);
        assert_eq!(p.z, -opposite_p.z);
        assert_eq!(v.x, -opposite_v.x);
        assert_eq!(v.z, -opposite_v.z);
        assert_eq!(
            launch(
                &Swipe {
                    duration_ms: -1.0,
                    ..input.clone()
                },
                false
            )
            .unwrap(),
            launch(
                &Swipe {
                    duration_ms: 60.0,
                    ..input.clone()
                },
                false
            )
            .unwrap()
        );
        assert_eq!(
            launch(
                &Swipe {
                    duration_ms: 1e20,
                    ..input.clone()
                },
                false
            )
            .unwrap(),
            launch(
                &Swipe {
                    duration_ms: 1200.0,
                    ..input
                },
                false
            )
            .unwrap()
        );
    }

    #[test]
    fn invalid_inputs_return_errors() {
        assert!(simulate(3, swipe()).is_err());
        for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            for field in 0..5 {
                let mut input = swipe();
                match field {
                    0..=1 => input.start[field] = invalid,
                    2..=3 => input.delta[field - 2] = invalid,
                    _ => input.duration_ms = invalid,
                }
                assert!(simulate(6, input).is_err());
            }
        }
    }

    #[test]
    fn percentile_includes_one_through_one_hundred_once_each() {
        let mut results = BTreeSet::new();
        for tens in (0..100).step_by(10) {
            for units in 1..=10 {
                results.insert(percentile(tens, units));
            }
        }
        assert_eq!(results, (1..=100).collect());
        assert_eq!(percentile(0, 10), 100);
        assert_eq!(percentile(90, 10), 90);
        assert_eq!(percentile(0, 1), 1);
    }

    #[test]
    fn percentile_bodies_really_collide_in_the_same_world() {
        let mut world = World::new();
        let mut handles = Vec::new();
        for (kind, x, vx) in [(100, -0.8, 3.0), (10, 0.8, -3.0)] {
            let mesh = geometries().iter().find(|g| g.kind == kind).unwrap();
            handles.push(
                world
                    .add_die(
                        mesh,
                        Isometry::translation(x, 1.2, 0.0),
                        vector![vx, 0.0, 0.0],
                        Vector::zeros(),
                    )
                    .unwrap(),
            );
        }
        let a = world.bodies[handles[0]].colliders()[0];
        let b = world.bodies[handles[1]].colliders()[0];
        let mut contact = false;
        for _ in 0..60 {
            world.step();
            contact |= world
                .narrow_phase
                .contact_pair(a, b)
                .is_some_and(|p| p.has_any_active_contact);
        }
        assert!(contact, "percentile dice must not be separate simulations");
        assert!(
            world.bodies[handles[0]].translation().x < world.bodies[handles[1]].translation().x
        );
    }

    #[test]
    fn d4_reads_downward_face_and_cocked_or_stacked_dice_are_rejected() {
        for kind in [4, 6, 10, 20] {
            let mesh = geometries().iter().find(|g| g.kind == kind).unwrap();
            for face in &mesh.faces {
                let target = if kind == 4 { -Vector::y() } else { Vector::y() };
                let rotation =
                    UnitQuaternion::rotation_between(&Vector::from(face.normal), &target)
                        .unwrap_or_else(|| {
                            UnitQuaternion::from_axis_angle(&Vector::x_axis(), std::f32::consts::PI)
                        });
                let lowest = mesh
                    .vertices
                    .iter()
                    .map(|v| (rotation * Vector::from(*v)).y)
                    .fold(f32::INFINITY, f32::min);
                let body = RigidBodyBuilder::dynamic()
                    .position(Isometry::from_parts(
                        vector![0.0, -lowest, 0.0].into(),
                        rotation,
                    ))
                    .build();
                assert_eq!(resting_face(mesh, &body), Some(face.value));
                let stacked = RigidBodyBuilder::dynamic()
                    .position(Isometry::from_parts(
                        vector![0.0, -lowest + 0.5, 0.0].into(),
                        rotation,
                    ))
                    .build();
                assert_eq!(resting_face(mesh, &stacked), None);
            }
        }
        let cube = geometries().iter().find(|g| g.kind == 6).unwrap();
        let rotation = UnitQuaternion::from_euler_angles(0.0, 0.0, std::f32::consts::FRAC_PI_4);
        let edge = RigidBodyBuilder::dynamic()
            .position(Isometry::from_parts(
                vector![0.0, RADIUS * (2.0_f32 / 3.0).sqrt(), 0.0].into(),
                rotation,
            ))
            .build();
        assert_eq!(resting_face(cube, &edge), None);
    }

    #[test]
    fn nudge_wakes_cocked_body_without_teleporting() {
        let mut world = World::new();
        let mesh = geometries().iter().find(|g| g.kind == 6).unwrap();
        let handle = world
            .add_die(
                mesh,
                Isometry::translation(0.0, 1.0, 0.0),
                Vector::zeros(),
                Vector::zeros(),
            )
            .unwrap();
        world.step(); // Update mass/inertia before applying an impulse.
        let body = &mut world.bodies[handle];
        body.sleep();
        let before = *body.position();
        nudge(body, &mut StdRng::seed_from_u64(5));
        assert!(!body.is_sleeping());
        assert_eq!(*body.position(), before);
        assert!(body.linvel().y > 0.0);
        assert!(body.angvel().norm() > 0.0);
    }

    #[test]
    #[ignore = "larger deterministic physics soak test; run in release mode"]
    fn seeded_soak_test() {
        for seed in 0..100 {
            for kind in [4, 6, 8, 10, 12, 20, 100] {
                let mut rng = StdRng::seed_from_u64(seed * 1000 + u64::from(kind));
                let input = Swipe {
                    start: [rng.gen_range(-1.0..1.0), rng.gen_range(-1.0..1.0)],
                    delta: [rng.gen_range(-2.0..2.0), rng.gen_range(-2.0..2.0)],
                    duration_ms: rng.gen_range(60.0..1200.0),
                };
                let simulation = simulate_with_rng(kind, input, &mut rng)
                    .unwrap_or_else(|e| panic!("d{kind}, seed {seed}: {e}"));
                assert_replay(&simulation, kind);
            }
        }
    }
}
