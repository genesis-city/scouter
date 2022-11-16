const axios = require('axios');
const inquirer = require('inquirer');
const { Console, dir} = require('console');
const fs = require('fs');
const { Int32, ConnectionCheckOutStartedEvent } = require('mongodb');
let mongoose = require('mongoose')
let parcelSchema = new mongoose.Schema({ coords: String, id: String, dirty: Boolean })
const Parcel = mongoose.model('Parcel', parcelSchema)
const dotenv = require("dotenv");
const { reduce } = require('async');
const { join, normalize } = require('path');
const { json } = require('express');
const { isNumberObject } = require('util/types');
dotenv.config()

var geoJsonFile = fs.createWriteStream('geo.json')
var estatesJsonFile = fs.createWriteStream('estates.json')
var coordsStream = fs.createWriteStream('coords.txt')
var coordsRawStream = fs.createWriteStream('raw_coords.txt')
var logger = fs.createWriteStream('logs.txt', {flags: 'a' /*append*/})
const args = process.argv.slice(2)

const choices = [
  'Full run', 
  'Mark all as clean',
  'Round coords for unity', 
  // 'Delete database',
  'Estate tests'];

// inquirer
//   .prompt([
//     {
//       type: 'list',
//       name: 'mode',
//       message: 'What do you want to do?',
//       choices: choices,
//     },
//   ])
//   .then(answers => {
//     switch (answers.mode) {
//       case choices[0]:
//         run().catch(error => logMessage(error.stack))
//         break;
//       case choices[1]:
//         markAllAsClean().catch(error => logMessage(error.stack))
//         break;
//       case choices[2]:
//         roundCoordsForUnity().catch(error => logMessage(error.stack))
//         break;
//       // case choices[3]:
//       //   deleteDatabase().catch(error => logMessage(error.stack))
//       //   break;
//       case choices[3]:
  //       getEstates().catch(error => logMessage(error.stack))
  //       break;
  //     default:
  //       logMessage('Option not found');
  //       process.exit();
  //   }
  // });

async function run() {
  logMessage("Full run started")
  await connectToDB()

  logMessage("Looking for dirty parcels in db...")
  let dbParcels = await getDirtyParcels()
  logMessage(`Parcels found ${dbParcels.length}`)

  var allCoords = generateCoordsArray()

  // Check if need to apply filter to allCoords array
  if (dbParcels.length > 0) {
    logMessage(`Filtering array (${allCoords.length}) with db parcels...`)
    allCoords = filterParcelsWithDB(allCoords, dbParcels)
    logMessage(`Total parcels after filter: ${allCoords.length}`)
  }

  if (args.includes('resume')) {
    let resumeAtIndex = allCoords.indexOf(args[1])
    logMessage(`Found resume coord at index: ${resumeAtIndex}`)
    logMessage(`AllCoords: ${allCoords.length}`)
    if (resumeAtIndex > 0) {
      var removed = allCoords.splice(0, resumeAtIndex)
      logMessage(`Resume at: ${resumeAtIndex}, allCoords: ${allCoords.length}`)
    } 
  }

  // Start making requests
  let result = await manageCoordsRequests(allCoords)
  logMessage(result)

  // Make coords.txt in desktop for Unity
  // await roundCoordsForUnity()

  logMessage("Full run finished")
  logger.end()
}

// FUNCTIONS
function generateCoordsArray() {
  let maxX = 150
  let maxY = 150
  var allCoords = []
  
  for (let xIndex = -maxX; xIndex <= maxX; xIndex++) {
    for (let yIndex = -maxY; yIndex <= maxY; yIndex++) {
      allCoords.push(`${xIndex},${yIndex}`)
    }
  }
  return allCoords
}

function filterParcelsWithDB(allCoords, dbParcels) {
  let dbCoords = dbParcels.map(parcel => parcel.coords)
  return allCoords.filter(el => !dbCoords.includes(el))
}

async function manageCoordsRequests(allCoords) {
  // allCoords.length = 200 //Get N elements from array for testing purpose only
  while (allCoords.length > 0) {
    logMessage(`Coords remaining: ${allCoords.length}`)
    let targetCoords = allCoords[0]
    let parcel = await getContentFromCoords(targetCoords)
    for await (const coord of parcel.pointers) {
      await compareParcelAndSave(coord, parcel.id)
    }
    allCoords = allCoords.filter(el => !parcel.pointers.includes(el))
  }
  return "FINISHED REQUESTING PARCELS"
}

async function getContentFromCoords(coords) {
  try {
    logMessage(`Requesting: ${coords}`)
      const response = await axios.get(`https://peer.decentraland.org/content/entities/scene?pointer=${coords}`)
      if (response.data.length == 0) {
        logMessage(`Id for ${coords}: Empty`)
        return {"id": "", "pointers": [coords]}
      }
      let parcel = response.data[0]
      if ('id' in parcel && 'pointers' in parcel) {
        logMessage(`Id for ${coords}: ${parcel.id} shared with ${parcel.pointers.length - 1} other coords.`)
        return {"id": parcel.id, "pointers": parcel.pointers }
      }
      logMessage(`Response without required fields: ${response}`)
  } catch(err) {
      logMessage(err)
  }
}

async function compareParcelAndSave(coords, id) {
  let parcel = await Parcel.findOne({ coords: `${coords}` }).exec();
  if ((parcel != null) && (parcel.dirty == true || parcel.id == id)) {
    logMessage(`Coords ${coords} already saved/dirty`)  
    return
  }
  createAndSaveParcel(coords, id)
}

// Database methods
async function connectToDB() {
  logMessage("Connecting to db...")
  await mongoose.connect(`mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@mapper.odqgd.mongodb.net/myFirstDatabase?retryWrites=true&w=majority`)
  logMessage("Db connected.")
}

function createAndSaveParcel(coords, id) {
  let newParcelData = { coords: coords, id: id, dirty: true }
  let oldParcelData = Parcel.findOneAndUpdate({ coords: `${coords}` }, newParcelData, {upsert: true}).exec()
  logMessage(`Coords ${coords} saved. Old id: ${oldParcelData.id} - New id: ${newParcelData.id}`)
  // logCoords(coords, id)
}

async function getDirtyParcels() { 
  return await Parcel.find({ dirty: true }).exec()
}

async function markAllAsClean() {
  await connectToDB()
  let parcels = await Parcel.updateMany(null, { dirty: false })
  logMessage(`All cleaned - ${parcels.acknowledged} ${(await getDirtyParcels()).length}`)
}

async function deleteDatabase() {
  await connectToDB()
  await Parcel.deleteMany()
  logMessage("All deleted")
}

// Generating results for Unity renderer in coords.txt
const unitySize = 5
const roundForUnitySize = x => Math.round(x/unitySize)*unitySize

async function roundCoordsForUnity() {
  logMessage("Rounding coords for unity")
  await connectToDB()
  let dirtyParcels = await getDirtyParcels()

  console.log(`Dirty parcels found: ${dirtyParcels.length}`)
  let rawCoords = dirtyParcels.slice()
  generateGeoJson(rawCoords)
  var groupedRawCoords = []

  while (rawCoords.length > 0) {
    var coords = []
    let parcel = rawCoords[0]
    // console.log(`Current coords: ${parcel.coords} - id: ${parcel.id}`)
    if (parcel.id == '') {
      coords = [parcel.coords]
    } else {
      let estateCoords = rawCoords.filter(el => el.id == parcel.id)
      // console.log(`estateCoords ${estateCoords.length}`)
      let mappedCoords = estateCoords.map(el => el.coords)
      // console.log(`mappedCoords ${mappedCoords.length}`)
      coords = mappedCoords
    }
    groupedRawCoords.push(coords)
    rawCoords = rawCoords.filter(el => !coords.includes(el.coords))
  }

  let roundedCoords = []
  dirtyParcels.map(el => {
    let intCoords = el.coords.split(',')
    if (intCoords.length != 2) { return }
    let x = roundForUnitySize(parseInt(intCoords[0]))
    let y = roundForUnitySize(parseInt(intCoords[1]))
    if (Math.abs(x) > 150 || Math.abs(y) > 150) { return }
    let rounded = `${x},${y}`
    el.coords = rounded
    roundedCoords.push(el)
  })
  dirtyParcels = roundedCoords

  var groupedCoords = []
  while (dirtyParcels.length > 0) {
    var coords = []
    let parcel = dirtyParcels[0]
    // console.log(`Current coords: ${parcel.coords} - id: ${parcel.id}`)
    if (parcel.id == '') {
      coords = [parcel.coords]
    } else {
      let estateCoords = dirtyParcels.filter(el => el.id == parcel.id)
      // console.log(`estateCoords ${estateCoords.length}`)
      let mappedCoords = estateCoords.map(el => el.coords)
      // console.log(`mappedCoords ${mappedCoords.length}`)
      coords = mappedCoords
    }
    groupedCoords.push(coords)
    dirtyParcels = dirtyParcels.filter(el => !coords.includes(el.coords))
  }

  let sets = groupedCoords.map(el => {
    return new Set(el)
  })

  let rawSets = groupedRawCoords.map(el => {
    return new Set(el)
  })
  // console.log(rawSets)
  let mappedRaw = rawSets.map(el => Array.from(el).join(';'))
  let allRaw = mappedRaw.join('\n')
  coordsRawStream.write(allRaw)
  coordsRawStream.end()

  let mapped = sets.map(el => Array.from(el).join(';'))
  //console.log(mapped)
  let all = mapped.join('\n')
  coordsStream.write(all)
  coordsStream.end()
  process.exit()
}

// TODO: revert!
// const parcelSize = 40
// const mapSize = 152
const parcelSize = 40
const mapSize = 150

function generateGeoJson(coords) {
  // console.log(allRaw)
  let coordsJson = []
  Array.from(coords).forEach(el => {
    // console.log(el)
    let intCoords = el.coords.split(',')
    var x = parseInt(intCoords[0]) + mapSize
    var y = parseInt(intCoords[1]) + mapSize
    x = x * parcelSize
    y = y * parcelSize
    coordsJson.push({"type":"Feature","geometry": {"type":"Polygon","coordinates":[[[x,y],[x,y+parcelSize],[x+parcelSize,y+parcelSize],[x+parcelSize,y],[x,y]]]}})
  })

  let geoJson = JSON.stringify({"type":"FeatureCollection","features":coordsJson})

  geoJsonFile.write(geoJson)
  geoJsonFile.end()
}

// Logger functions
function logMessage(message) {
  let fullMessage = `[${getCurrentDateAndTime()}]: ${message}`
  console.log(fullMessage)
  logger.write(fullMessage + "\n")
}

function getCurrentDateAndTime() {
  return `${new Date().toString()}`
}


  //////////////////////////////////////////////////////////
 ////////////////////  ESTATES START  /////////////////////
//////////////////////////////////////////////////////////
async function getEstates() {
  try {
    const fname = 'estates-raw.txt';
    let response = null;
    let exists = false
    try {
      exists = fs.existsSync(fname)
    } catch(err) {
    }
    if (exists) {
      const fdata = JSON.parse(fs.readFileSync(fname))
      response = {data: fdata};
    } else {
      response = await axios.get(`https://api.decentraland.org/v1/tiles`)
      fs.writeFileSync(fname, JSON.stringify(response.data));
    }
    const tiles = response.data.data;
    // all tiles
    console.log(Object.entries(tiles).length, 'total tiles');
    // tiles belonging to an estate
    tilesInEstate = Object.entries(tiles).filter(([coord, info]) => 'estate_id' in info);
    console.log(tilesInEstate.length, 'tiles within estate')

    // build tiles for each estate id
    tilesForEstate = {}
    tilesInEstate.every(([_, info]) => {
      if (!tilesForEstate[info.estate_id]) {
        tilesForEstate[info.estate_id] = []
      }
      tilesForEstate[info.estate_id].push(info)
      return true;
    })
    console.log(Object.entries(tilesForEstate).length, 'estates total containing', tilesInEstate.length, 'tiles');
    
    let allPolygons = []
    // const WWW  = 7;
    Object.entries(tilesForEstate)/*.slice(WWW,WWW+1)*/.every(([estate_id, tiles]) => {
      if (estate_id != "4274") { //1817 hardcore
        return true;
      }
      const estatePolygons = drawEstate(estate_id, tiles);
      estatePolygons.every((polygon) => {
        polygon.estate_id = estate_id;
        allPolygons.push(polygon);
      });
      return true;
    })

    // let mocked = mockEstate()
    // estates.push(drawEstate(mocked.nft.data.estate.parcels))

    // console.log("Drawing RESULT", estates)
    console.log("estates length:", allPolygons.length)
    drawPolygon(allPolygons[0]);
    generateEstatesJSON(allPolygons)
    process.exit()
  } catch(err) {
    logMessage(err)
    throw err
  }
}
const assert = function(condition, message) {
  if (!condition)
      throw Error('Assert failed: ' + (message || ''));
};

function addAll(set, iter) {
  iter.map(JSON.stringify).forEach(set.add.bind(set));
}

function remove(list, elem) {
  list.splice(list.indexOf(elem), 1);
}

function findAdjacent(vertices, queue) {
  // console.log('finding new adjacent point');
  const vsize = vertices.size;
  const qsize = queue.length;
  for(const pending of queue) {
    // console.log('considering', pending.center);
    const simulate = new Set(vertices);
    addAll(simulate, pending.points);
    // console.log('simulate', simulate);
    // console.log('pending.points', pending.points);
    const delta = simulate.size - vertices.size;
    // console.log('vertices', vertices.size, 'simulate', simulate.size, 'delta', delta);
    // if adding points to the vertex set adds less than 2 vertices then it must be a neighbor.
    // (otherwise it will add 3 or 4 new points to the set)
    if (delta <= 2) {
      assert(vertices.size === vsize, 'vertices changed size and it shouldnt');
      assert(queue.length === qsize, 'queue changed length and it shouldnt');
      return pending;
    }
  }
  assert(false, 'no adjacent found!!')
}


function drawEstate(estate_id, tiles) {
  console.log("Drawing estate:", estate_id, tiles.length);
  let queue = tiles.map(tile => {
    const center = {x: tile.x, y: tile.y}
    return {center: center, points: centerToVertices(center), edges: centerToEdges(center)}
  })

  const first = queue[0];
  // remove first from estateData
  queue = queue.filter(item => item !== first);
  // console.log('first', first);

  const centers = new Set();
  centers.add(first.center);
  const vertices = new Set();
  addAll(vertices, first.points);
  const border = new Set();
  addAll(border, first.edges);
  // calculate all vertices
  while (queue.length > 0) {
    // console.log('>>>> iteration', queue.length);
    // console.log('>>>> vertices', vertices);
    // console.log('>>>> centers', centers);

    // get an adjacent center 
    const adjacent = queue[0];

    // add it to the set of vertices
    addAll(vertices, adjacent.points);

    // add it to the set of centers
    centers.add(adjacent.center);

    // add new edges to the set of border edges
    // console.log('edges!')
    adjacent.edges.every(([A, B]) => {
      // console.log('edge', A, B);
      // remove existing edge if present
      const AB = JSON.stringify([A,B]);
      const BA = JSON.stringify([B,A]);
      if (border.has(AB) || border.has(BA)) {
        // console.log('removing edge', AB);
        border.delete(AB);
        border.delete(BA);
      } 
      // otherwise, add it!
      else {
        border.add(AB);
      }
      return true;
    });
    // console.log('border', border);

    // remove it from the queue
    remove(queue, adjacent);
  }

  // remove internal vertices
  const removeMe = [];
  Array.from(vertices).every((vs) => {
    const v = JSON.parse(vs);
    // console.log('v', v);

    // neighbor vertices
    const neighbors = [
      {x: v.x-parcelSize, y: v.y}, //left
      {x: v.x+parcelSize, y: v.y}, // right
      {x: v.x, y: v.y+parcelSize}, // up
      {x: v.x, y: v.y-parcelSize}, // down
    ];
    // console.log('checking for', neighbors);
    const allNeighborsPresent = neighbors.every((n)=>{
      return vertices.has(JSON.stringify(n));
    });

    // neighbor centers
    const vcenters = vertexToCenters(v);
    // console.log(centers);
    const allCentersPresent = vcenters.every((vc) => {
      return centers.has(vc);
    })

    if (allNeighborsPresent && allCentersPresent) {
      removeMe.push(v);
    }
    return true;
  })
  // console.log('remove set', removeMe.length);
  // console.log('size pre remove', vertices.size);
  assert(removeMe.every((toRemove) => {
    return vertices.delete(JSON.stringify(toRemove));
  }), 'tried to removed non-existing vertex from vertices');
  // console.log('size post remove', vertices.size);

  const polygon = {
    vertices: vertices,
    centers: centers,
    border: border,
  }
  return [polygon];
}

const cache = {}
function centerToVertices(center /* {"x":0, "y":0} */) {
  // TODO: revert this!
  // TODO: changed for ease of manual checks, revert to totti's original
  let x = center.x + mapSize
  let y = center.y + mapSize
  x = x * parcelSize
  y = y * parcelSize
  const ret = [{"x": x,"y": y},{"x": x+parcelSize,"y": y},{"x": x+parcelSize,"y": y+parcelSize},{"x": x,"y": y+parcelSize}]
  
  ret.every((p)=>{
    if (!cache[p.x]) cache[p.x] = {}
    if (!cache[p.x][p.y]) cache[p.x][p.y] = []
    cache[p.x][p.y].push(center)
    return true;
  })

  // console.log(cache);
  // console.log(cache[x][y])
  // process.exit(1);
  return ret;
}
function centerToEdges(center) {
  vxs = centerToVertices(center);
  return [[vxs[0], vxs[1]], [vxs[1], vxs[2]], [vxs[2], vxs[3]], [vxs[3], vxs[0]]]
}
function vertexToCenters(vertex) {
  let x = vertex.x / parcelSize - mapSize;
  let y = vertex.y / parcelSize - mapSize;
  const ret = [{x: x, y:y},{x: x-1, y:y},{x: x, y:y-1},{x: x-1, y:y-1}]
  return ret
}

function generateEstatesJSON(polygons) {
  let polygonJSONs = polygons.map(polygon => {
    return generatePolygonJson(polygon);
  })
  
  let estatesJson = JSON.stringify({"type":"FeatureCollection", "crs": {"type": "name", "properties": {"name": "ESTATES"}}, "features":polygonJSONs}, null, 1)
  fs.writeFileSync('estates.json', estatesJson);
  // estatesJsonFile.write(estatesJson)
  // estatesJsonFile.end()
  console.log("Estates json created")
}

function generatePolygonJson(polygon) {
  // console.log('generateJSON', polygon)
  var result = [];
  Array.from(polygon.border).map((edge_str) => {
    [A, B] = JSON.parse(edge_str);
    result.push([A.x, A.y])
    result.push([B.x, B.y]);
  })
  return {"type":"Feature","geometry": {"type":"LineString","coordinates":[result]}}
}
/////////////////////  ESTATES END  /////////////////////

function rotate(arr, count) {
  count -= arr.length * Math.floor(count / arr.length);
  arr.push.apply(arr, arr.splice(0, count));
  return arr;
}
// function mockEstate() {
//   // let data = [{"x": -71,"y": 125},{"x": -71,"y": 126},{"x": -71,"y": 127},{"x": -71,"y": 129},{"x": -70,"y": 125},{"x": -70,"y": 126},{"x": -70,"y": 127},{"x": -70,"y": 128},{"x": -70,"y": 129}]
//   let  data = [{"x": 0,"y": 0}, {"x": 1,"y": 0}, {"x": 2,"y": 0}, {"x": 0,"y": 1}, {"x": 2,"y": 1}, {"x": 0,"y": 2}, {"x": 2,"y": 2}]
//   processEstateData(data)
// }



const { createCanvas } = require('canvas')
function normalizeVertices(string_vertices) {

  const vertices = Array.from(string_vertices).map(JSON.parse);
  let minx = 123456789;
  let miny = 123456789;
  for (const vs  of vertices) {
    if (vs.x < minx) minx = vs.x;
    if (vs.y < miny) miny = vs.y;
  }
  const padded = vertices.map((v)=>{
    return {x: v.x-minx, y: v.y-miny};
  });

  return padded.map((v)=>{
    return {x: v.x/parcelSize, y: v.y/parcelSize};
  });
}
function normalizeCenters(center_set) {
  const centers = Array.from(center_set);
  let minx = 123456789;
  let miny = 123456789;
  for (const vs  of centers) {
    if (vs.x < minx) minx = vs.x;
    if (vs.y < miny) miny = vs.y;
  }
  const padded = centers.map((v)=>{
    return {x: v.x-minx, y: v.y-miny};
  });
  return padded;
}
function normalizeBorder(border_string) {
  const border = Array.from(border_string).map(JSON.parse);
  let minx = 123456789;
  let miny = 123456789;
  for (const [A, B] of border) {
    if (A.x < minx) minx = A.x;
    if (A.y < miny) miny = A.y;
    if (B.x < minx) minx = B.x;
    if (B.y < miny) miny = B.y;
  }
  const padded = border.map(([A,B])=>{
    return [{x: A.x-minx, y: A.y-miny}, {x: B.x-minx, y: B.y-miny}];
  });
  
  return padded.map(([A,B])=>{
    return [{x: A.x/parcelSize, y: A.y/parcelSize}, {x: B.x/parcelSize, y: B.y/parcelSize}];
  });
}
function drawPolygon({vertices, centers, border, estate_id}) {
  const normalized = normalizeVertices(vertices);
  const normCenters = normalizeCenters(centers);
  const normBorder = normalizeBorder(border);
  
  const width = 800;
  const height = 800;
  const canvas = createCanvas(width, height);
  const drawScale = 10;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  // tiles
  ctx.fillStyle = 'red';
  Array.from(normCenters).map((c)=>{
    ctx.fillRect(c.x*drawScale+100+drawScale/10,c.y*drawScale+100+drawScale/10,4*drawScale/5,4*drawScale/5);
  })
  // vertices
  ctx.fillStyle = 'blue';
  normalized.map((v) => {
    ctx.fillRect(v.x*drawScale+100-drawScale/10,v.y*drawScale+100-drawScale/10,drawScale/5,drawScale/5);
  });
  // edges
  ctx.fillStyle = 'green';
  // console.log('normBorder #', normBorder.length);
  normBorder.map(([A, B]) => {
    const dx = B.x - A.x;
    const dy = B.y - A.y;

    ctx.beginPath();
    ctx.moveTo(A.x*drawScale+100, A.y*drawScale+100);
    ctx.lineTo(B.x*drawScale+100, B.y*drawScale+100);
    ctx.closePath();
    ctx.stroke();
    // ctx.fillRect(A.x*drawScale+100-drawScale/10,A.y*drawScale+100-drawScale/10,dx*drawScale/5,dy*drawScale/5);
  });
  // save image
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync('./image.png', buffer);
  console.log('estate id=',estate_id);
}


function mockEstate() {
  return JSON.parse('{"nft":{"id":"0x959e104e1a4db6317fa58f8295f586e1a978c297-3847","tokenId":"3847","contractAddress":"0x959e104e1a4db6317fa58f8295f586e1a978c297","activeOrderId":"0x7068c5480f4f73895395e216ea32e45d81ae758c4e13f0db43fce0df3d2e3070","openRentalId":null,"owner":"0x3a572361910939dfc230bc010dadc9de7bd3af4b","name":"South  left gate","image":"https://api.decentraland.org/v1/estates/3847/map.png","url":"/contracts/0x959e104e1a4db6317fa58f8295f586e1a978c297/tokens/3847","data":{"estate":{"description":"South  left gate!","size":13,"parcels":[{"x":-2,"y":-150},{"x":-2,"y":-144},{"x":-2,"y":-143},{"x":-2,"y":-142},{"x":-1,"y":-150},{"x":-1,"y":-149},{"x":-1,"y":-148},{"x":-1,"y":-147},{"x":-1,"y":-146},{"x":-1,"y":-145},{"x":-1,"y":-144},{"x":-1,"y":-143},{"x":-1,"y":-142}]}},"issuedId":null,"itemId":null,"category":"estate","network":"ETHEREUM","chainId":1,"createdAt":1601652467000,"updatedAt":1663477751000,"soldAt":0},"order":{"id":"0x7068c5480f4f73895395e216ea32e45d81ae758c4e13f0db43fce0df3d2e3070","marketplaceAddress":"0x8e5660b4ab70168b5a6feea0e0315cb49c8cd539","contractAddress":"0x959e104e1a4db6317fa58f8295f586e1a978c297","tokenId":"3847","owner":"0x3a572361910939dfc230bc010dadc9de7bd3af4b","buyer":null,"price":"1755001000000000000000000","status":"open","network":"ETHEREUM","chainId":1,"expiresAt":1671667200000,"createdAt":1643357946000,"updatedAt":1643357946000},"rental":null}')
}

// test findAdjacent
// console.log(centerToVertices( {"x":0, "y":0}));
// console.log(centerToVertices( {"x":1, "y":0}));
const zz = {"x":0, "y":0};
const p0s = centerToVertices(zz);
// console.log(p0s);
const vs = new Set();
addAll(vs, p0s);
const ret = findAdjacent(vs, [{center: {"x":0, "y":0}, points: centerToVertices( {"x":1, "y":0})}])
// console.log(ret);

// test vertexToCenters
// console.log('vertexToCenters', p0s[0],'->', vertexToCenters(p0s[0]))

// console.log(centerToEdges(zz))

getEstates().catch(error => logMessage(error.stack))