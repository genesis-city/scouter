const axios = require('axios');
const axiosRetry = require('axios-retry');
axiosRetry(axios, { retries: 5 } );
const fs = require('fs');
let mongoose = require('mongoose')
let parcelSchema = new mongoose.Schema({ coords: String, id: String, dirty: Boolean })
const Parcel = mongoose.model('Parcel', parcelSchema)
const dotenv = require("dotenv");
dotenv.config()
var dir = './output';
!fs.existsSync(dir) && fs.mkdirSync(dir);
var logger = fs.createWriteStream('./output/logs.txt', {flags: 'a' /*append*/})
const { Command } = require('commander');
const program = new Command();
var resumeAt = null
/* ----------------------- Initialize Cloud Firestore ----------------------- */
const { initializeApp, applicationDefault, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue, Filter } = require('firebase-admin/firestore');
const serviceAccount = require('./genesis-city-40d7e-dee494012657.json');
const { asyncify } = require('async');
initializeApp({
    credential: cert(serviceAccount)
});
const db = getFirestore();
/* --------------------------- Points of Interest Start--------------------------- */
const coordsEndpoint = 'https://peer.decentraland.org/lambdas/contracts/pois';
const metaDataBaseURL = 'https://places.decentraland.org/api/places?';
const invalidPOIs = readInvalidPOIsList();
// invalidPOIs are Points of Interest that are present in the smartContract (0x0ef15a1c7a49429a36cb46d4da8c53119242b54e) but then filtered by the unity-renderer and shouldn't be present in decentraland's map.
/* --------------------------- Points of Interest End--------------------------- */

program
  .name('Scouter')

program.command('scout')
  .description('Scout for changes in all parcels.')
  .option('-c, --clean', 'Clean database (dirty=false) before starting scouting')
  .option('-r, --resume <x,y>', 'Coords to resume scouting at (eg. -142,38)')
  .option('-p, --parcels-changelog', 'Generate coords.txt and geo.json with modified parcels')
  .option('-t, --test', 'Test database connection configuration')
  .action(async (option) => {
    if (option.test) {
      testDBConnection();
      return;
    }
    if (option.clean) {
      let cleanResult = await markAllAsClean().catch(error => {
        logMessage(error.stack) 
        process.exit()
        }) 
      console.log(cleanResult)
    }
    if (option.resume) {
      resumeAt = option.resume
      console.log("RESUME AT:", option.resume)
    }

    let runResult = await run().catch(error=> { 
      logMessage(error.stack)
      process.exit()
    })
    console.log(runResult)

    if (option.parcelsChangelog) {
      let generateCoordsResult = await roundCoordsForUnity().catch(error => logMessage(error.stack))
      console.log(generateCoordsResult)
    }
    console.log("All scout tasks finished")
    process.exit()
  });

program.command('parcels-changelog')
  .description('Generate coords.txt and geo.json with modified parcels')
  .action(async () => {
    let generateCoordsResult = await roundCoordsForUnity().catch(error => logMessage(error.stack))
    console.log(generateCoordsResult)
    process.exit()
  })

program.command('draw-estates')
  .description('Generate estates.json')
  .action(async () => {
    let estatesResult = await getEstates()
    console.log(estatesResult)
    process.exit()
  })

program.command('update-pois')
  .description('Generate pois.json')
  .action(async () => {
    updatePOIsData();
  })

// program.command('delete-database')
//   .description('WARNING: Delete all database')
//   .action(async () => {
//     let deleteResult = await deleteDatabase().catch(error => logMessage(error.stack))
//     console.log(deleteResult)
//     process.exit
//   })

program.parse();

async function run() {
  logMessage("Full run started")
  await connectToDB()

  logMessage("Looking for dirty parcels in db...")
  let dbParcels = await getDirtyParcels()
  logMessage(`Parcels found ${dbParcels.length}`)

  var allCoords = generateCoordsArray()

  // Check if need to apply filter to allCoords array
  if (dbParcels.length > 0) {
    logMessage(`Filtering array (${allCoords.length}) with db parcels (this will remove already dirty parcels)...`)
    allCoords = filterParcelsWithDB(allCoords, dbParcels)
    logMessage(`Total parcels after filter: ${allCoords.length}`)
  }

  if (resumeAt != null) {
    let resumeAtIndex = allCoords.indexOf(resumeAt)
    logMessage(`Found resume coord at index: ${resumeAtIndex}`)
    logMessage(`AllCoords: ${allCoords.length}`)
    if (resumeAtIndex > 0) {
      allCoords.splice(0, resumeAtIndex)
      logMessage(`Resume at: ${resumeAtIndex}, allCoords: ${allCoords.length}`)
    } 
  }

  // Start making requests
  let result = await manageCoordsRequests(allCoords)
  logMessage(result)
  return result
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
  let dbCoords = dbParcels.map(parcel => parcel.coords);
  return allCoords.filter(el => !dbCoords.includes(el))
}

async function manageCoordsRequests(allCoords) {
  // allCoords.length = 200 //Get N elements from array for testing purpose only
  while (allCoords.length > 0) {
    logMessage(`Coords remaining: ${allCoords.length}`)
    let targetCoords = allCoords[0]
    let parcel = await getContentFromCoords(targetCoords)
    for await (const coord of parcel.pointers) {
      // TODO: store a cache in memory of dirty parcels to reduce amount of requests
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
  if (parcel != null && parcel.id == id) {
    logMessage(`Coords ${coords} already saved as dirty, skipping...`)  
    return
  }
  createAndSaveParcel(coords, id)
}

// Database methods
async function connectToDB() {
  logMessage("Connecting to db...")
  const dbConnectionUrl = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@${process.env.DB_URL}/myFirstDatabase?retryWrites=true&w=majority`;
  // console.log(dbConnectionUrl);
  await mongoose.connect(dbConnectionUrl)
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

async function testDBConnection() {
  await connectToDB()
  return 'done';
}

async function markAllAsClean() {
  await connectToDB()
  let parcels = await Parcel.updateMany(null, { dirty: false })
  return `All cleaned - ${parcels.acknowledged} ${(await getDirtyParcels()).length}`
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
  var coordsStream = fs.createWriteStream('./output/coords.txt')
  var coordsRawStream = fs.createWriteStream('./output/raw_coords.txt')
  var geoJsonFile = fs.createWriteStream('./output/geo.json')
  var saleRentJsonFile = fs.createWriteStream('./output/saleRent.json')
  logMessage("Rounding coords for unity")
  await connectToDB()
  let dirtyParcels = await getDirtyParcels()

  logMessage(`Dirty parcels found: ${dirtyParcels.length}`)
  let rawCoords = dirtyParcels.slice()
  generateGeoJson(rawCoords, geoJsonFile)
  const landsForSaleRent = await getParcelsForSaleRent();
  generateSaleRentJson(landsForSaleRent, saleRentJsonFile);
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

  let reportedParcels = await getReportedParcels();
  dirtyParcels = dirtyParcels.concat(reportedParcels);

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
  let all = mapped.join('\n')
  coordsStream.write(all)
  coordsStream.end()
  process.exit()
}

async function getReportedParcels() {
  let reportedParcels = [];
  const reportedParcelsRef = db.collection('reportedParcels');
  const snapshot = await reportedParcelsRef.where('fixed', '==', false).get();
  const batch = db.batch();

  if (snapshot.empty) {
      logMessage('No new parcels reported.');
      return;
  }
  // Get Reported Parcels
  snapshot.forEach(doc => {
      reportedParcels.push({coords: doc.data().location.replace(/\n/g, '')})
      // Update the document
      batch.update(doc.ref, {
          fixed: true,
      });
      logMessage(`Reported parcel at: ${doc.data().location}`);
  });

  // Commit the batch. Update Review status on db
  await batch.commit();

  return reportedParcels;
}

const parcelSize = 40
const mapSize = 152

function generateGeoJson(coords, geoJsonFile) {
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

/* -------------------------------------------------------------------------- */
/*                  Process Items for Sale/Rent data - START                  */
/* -------------------------------------------------------------------------- */

async function fetchData(params) {
  const BASE_URL = 'https://nft-api.decentraland.org/v1/nfts';
  try {
      const response = await fetch(`${BASE_URL}?${params}`);
      const data = await response.json();
      return data.data;
  } catch (err) {
      console.log(err);
  }
}

function processParcel(item, parcelsForSaleRent) {
  const parcel = item.nft.data.parcel;
  const parcelData = {
      coords: `${parcel.x},${parcel.y}`,
      data: {
          category: item.nft.category,
          name: item.nft.name,
          salePrice: item.order?.price ? item.order.price / 1e18 : null,
          rentPrice: item.rental?.periods ? item.rental.periods[0].pricePerDay / 1e18 : null,
          featureType: 'saleRent',
          contractAddress: item.nft.contractAddress,
          tokenId: item.nft.tokenId,
      },
  }
  parcelsForSaleRent.push(parcelData);
}

function processEstate(item, parcelsForSaleRent) {
  const estate = item.nft.data.estate;
  const parcelsInEstate = estate.parcels.map(parcel => `${parcel.x},${parcel.y}`);
  estate.parcels.forEach(parcel => {
      const parcelData = {
          coords: `${parcel.x},${parcel.y}`,
          data: {
              category: item.nft.category,
              name: item.nft.name,
              size: estate.size,
              parcels: parcelsInEstate,
              salePrice: item.order?.price ? item.order.price / 1e18 : null,
              rentPrice: item.rental?.periods ? item.rental.periods[0].pricePerDay / 1e18 : null,
              featureType: 'saleRent',
              contractAddress: item.nft.contractAddress,
              tokenId: item.nft.tokenId,
          },
      }
      parcelsForSaleRent.push(parcelData);
  });
}

async function getParcelsForSaleRent() {
  const parcelsForSaleRent = [];

  const forSale = await fetchData('first=1000&skip=0&sortBy=newest&isOnSale=true&isLand=true');
  const forRent = await getParcelsForRent();
  let itemCount = 0;

  logMessage('Processing Items for Sale . . .');
  forSale.forEach(item => {
      itemCount++
      if (item.nft.data.parcel) processParcel(item, parcelsForSaleRent);
      if (item.nft.data.estate) processEstate(item, parcelsForSaleRent);
  });

  logMessage('Processing Items for Rent . . .');
  forRent.forEach(item => {
      if (!item.order) {
          itemCount++
          if (item.nft.data.parcel) processParcel(item, parcelsForSaleRent);
          if (item.nft.data.estate) processEstate(item, parcelsForSaleRent);
      }
  });
  logMessage(`There are ${itemCount} items for Sale/Rent, making a total of ${parcelsForSaleRent.length} parcels in Decentraland's marketplace.`);
  return parcelsForSaleRent;
}

function generateSaleRentJson(itemsForSaleRent, saleRentJsonFile) {
  let polygonsJson = []
  itemsForSaleRent.forEach(item => {
    let intCoords = item.coords.split(',')
    var x = parseInt(intCoords[0]) + mapSize
    var y = parseInt(intCoords[1]) + mapSize
    x = x * parcelSize
    y = y * parcelSize
    const feature = {
      "type":"Feature",
      "geometry": {"type":"Polygon","coordinates":[[[x,y],[x,y+parcelSize],[x+parcelSize,y+parcelSize],[x+parcelSize,y],[x,y]]]},
      "properties": item.data,
    }
    polygonsJson.push(feature)
  })

  let saleRentJson = JSON.stringify({"type":"FeatureCollection","features":polygonsJson})

  saleRentJsonFile.write(saleRentJson);
  saleRentJsonFile.end();
}

// Paginate request to overcome item response limit
async function getParcelsForRent() {
  const responses = [];
  const resItemLimit = 100;
  let round = 0;

  do {
    const forRentRes = await fetchData(`first=100&skip=${round*resItemLimit}&sortBy=newest&isOnRent=true&isLand=true`);
    responses.push(forRentRes);
    round++;
  } while (responses[round-1]?.length === resItemLimit);

  const parcelsForRent = [].concat(...responses);
  return parcelsForRent;
}

/* -------------------------------------------------------------------------- */
/*                   Process Items for Sale/Rent data - END                   */
/* -------------------------------------------------------------------------- */

// Logger functions
function logMessage(message) {
  let fullMessage = `[${getCurrentDateAndTime()}]: ${message}`
  console.log(fullMessage)
  logger.write(fullMessage + "\n")
}

function getCurrentDateAndTime() {
  return `${new Date().toUTCString()}`
}


  //////////////////////////////////////////////////////////
 ////////////////////  ESTATES START  /////////////////////
//////////////////////////////////////////////////////////
async function getEstates() {
  try {
    let response = null;
    let exists = false
    // const fname = 'estates-raw.txt';
    // try {
    //   exists = fs.existsSync(fname)
    // } catch(err) {
    // }
    if (exists) {
      const fdata = JSON.parse(fs.readFileSync(fname))
      response = {data: fdata};
    } else {
      console.log('Getting all tiles from https://api.decentraland.org/v2/tiles...')
      response = await axios.get(`https://api.decentraland.org/v2/tiles`)
      // fs.writeFileSync(fname, JSON.stringify(response.data));
    }
    const tiles = response.data.data;
    // all tiles
    console.log(Object.entries(tiles).length, 'total tiles');
    // tiles belonging to an estate
    tilesInEstate = Object.entries(tiles).filter(([coord, info]) => 'estateId' in info);
    console.log(tilesInEstate.length, 'tiles within estate')

    // build tiles for each estate id
    tilesForEstate = {}
    tilesInEstate.every(([_, info]) => {
      if (!tilesForEstate[info.estateId]) {
        tilesForEstate[info.estateId] = []
      }
      tilesForEstate[info.estateId].push(info)
      return true;
    })
    console.log(Object.entries(tilesForEstate).length, 'estates total containing', tilesInEstate.length, 'tiles');
    
    const perimeterPolygons = [];
    const areaPolygons = [];
    // const specific  = 7;
    Object.entries(tilesForEstate)/*.slice(specific,specific+1)*/.every(([estateId, tiles]) => {
      // if (estateId != "4274") { //1817 hardcore
      //   return true;
      // }
      const estatePerimeter = drawEstatePerimeter(estateId, tiles);
      estatePerimeter.every((perimeter) => {
        perimeter.estateId = estateId;
        perimeter.type = tiles[0].type;
        perimeter.name = tiles[0].name;
        perimeter.geoType = 'perimeter';
        addCrossPointCenter(perimeter);
        perimeterPolygons.push(perimeter);
      });

      const estateArea = drawEstateArea(estateId, tiles);
      estateArea.every((area) => {
        area.estateId = estateId;
        area.type = tiles[0].type;
        area.name = tiles[0].name;
        area.geoType = 'area';
        areaPolygons.push(area);
      });
      return true;
    })
    parsePolygonBorders(perimeterPolygons);
    offsetEstatesPerimeter(perimeterPolygons);
    stringifyPolygonBorders(perimeterPolygons);
    // DEBUG
    // console.log("allPolygons[1]:");
    // console.log(allPolygons[1]);
    // let mocked = mockEstate()
    // estates.push(drawEstatePerimeter(mocked.nft.data.estate.parcels))

    console.log("estates length:", areaPolygons.length);
    
    // draw to image using canvas
    // drawPolygon(allPolygons[0]);
    
    generateEstatesJSON(perimeterPolygons);
    generateEstatesJSON(areaPolygons);
    process.exit();
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

function addAllEdges(set, iter, center) {
  const parcelXMaxYMax = getParcelXMaxYMax(iter);
  iter.map((edge)=> { 
    const edgeType = getEdgeType(edge, parcelXMaxYMax);
    const edgeXMaxYMax = getEdgeXMaxYMax(edge);
    return {
      edge: JSON.stringify(edge),
      center: center,
      edgeType: edgeType,
      maxValues: {x: edgeXMaxYMax.x, y: edgeXMaxYMax.y},
      crossEdgePoints: [],
    }
  }).forEach(set.add.bind(set));
}

function remove(list, elem) {
  list.splice(list.indexOf(elem), 1);
}

function drawEstatePerimeter(estateId, tiles) {
  console.log("Drawing estate perimeter:", estateId, tiles.length);
  let queue = tiles.map(tile => {
    const center = {x: tile.x, y: tile.y}
    const points = centerToVertices(center);
    const edges = centerToEdges(center);
    const parcelXMaxYMax = getParcelXMaxYMax(edges);
    const edgesData = new Set();
    edges.forEach(edge => {
      const edgeType = getEdgeType(edge, parcelXMaxYMax);
      const edgeXMaxYMax = getEdgeXMaxYMax(edge);
      edgesData.add({edge: edge, center: center, type: edgeType, maxValues: {x: edgeXMaxYMax.x, y: edgeXMaxYMax.y}});
    })
    return {center: center, points: points, edges: edges, edgesData: edgesData}
  })

  const first = queue[0];
  remove(queue, first);

  const centers = new Set();
  centers.add(first.center);
  const vertices = new Set();
  addAll(vertices, first.points);
  const border = new Set();
  addAllEdges(border, first.edges, first.center);
  // calculate all vertices
  while (queue.length > 0) {
    // get an adjacent center 
    const adjacent = queue[0];

    // add it to the set of vertices
    addAll(vertices, adjacent.points);

    // add it to the set of centers
    centers.add(adjacent.center);

    // add new edges to the set of border edges
    adjacent.edgesData.forEach((edge) => {
      const [A, B] = edge.edge
      // remove existing edge if present
      const AB = JSON.stringify([A,B]);
      const BA = JSON.stringify([B,A]);
      if (setHasBorder(border, AB) || setHasBorder(border, BA)) {
        setDeleteBorder(border, AB);
        setDeleteBorder(border, BA);
      } 
      // otherwise, add it!
      else {
        border.add({
          edge: AB,
          center: adjacent.center,
          edgeType: edge.type,
          maxValues: edge.maxValues,
          crossEdgePoints: [],
        });
      }
      return true;
    });

    // remove it from the queue
    remove(queue, adjacent);
  }

  // remove internal vertices
  const removeMe = [];
  Array.from(vertices).every((vs) => {
    const v = JSON.parse(vs);

    // neighbor vertices
    const neighbors = [
      {x: v.x-parcelSize, y: v.y}, //left
      {x: v.x+parcelSize, y: v.y}, // right
      {x: v.x, y: v.y+parcelSize}, // up
      {x: v.x, y: v.y-parcelSize}, // down
    ];
    const allNeighborsPresent = neighbors.every((n)=>{
      return vertices.has(JSON.stringify(n));
    });

    // neighbor centers
    const vcenters = vertexToCenters(v);
    const allCentersPresent = vcenters.every((vc) => {
      return centers.has(vc);
    })

    if (allNeighborsPresent && allCentersPresent) {
      removeMe.push(v);
    }
    return true;
  })
  assert(removeMe.every((toRemove) => {
    return vertices.delete(JSON.stringify(toRemove));
  }), 'tried to removed non-existing vertex from vertices');

  const polygon = {
    vertices: vertices,
    centers: centers,
    border: border,
  }
  return [polygon];
}

function drawEstateArea(estateId, tiles) {
  console.log("Drawing estate area:", estateId, tiles.length);
  const multiPolygon = [];
  tiles.forEach(tile => {
    const center = {x: tile.x, y: tile.y}
    const polygon = centerToTilePolygon(center);
    multiPolygon.push({polygon: polygon, center: center})
  });
  return [{multiPolygon: multiPolygon}];
}

function setHasBorder(set, border) {
  let borderExists = false;
  set.forEach(item => item.edge === border && (borderExists = true))
  return borderExists;
}

function setDeleteBorder(set, border) {
  set.forEach(item => item.edge === border && set.delete(item));
}

function parsePolygonBorders(allPolygons) {
  allPolygons.forEach(polygon => {
    polygon.border?.forEach(item => {
      item.edge = JSON.parse(item.edge);
    })
  });
}

function stringifyPolygonBorders(allPolygons) {
  allPolygons.forEach(polygon => {
    polygon.border?.forEach(item => {
      item.edge = JSON.stringify(item.edge);
    })
  });
}

function edgeIsVertical(edge) {
  if (edge[0].x === edge[1].x) {
    return true;
  } else {
    return false;
  }
}

function getParcelXMaxYMax(edges) {
  const xValues = [];
  const yValues = [];
  edges.forEach(edge => {
    edge.forEach(coord => {
      xValues.push(coord.x);
      yValues.push(coord.y);
    });
  });
  const xMax = Math.max(...xValues);
  const yMax = Math.max(...yValues);
  return {xMax: xMax, yMax: yMax};
}

function getEdgeXMaxYMax(edge) {
  let xMax = 0;
  let yMax = 0;
  edge.forEach(point => {
    point.x > xMax && (xMax = point.x);
    point.y > yMax && (yMax = point.y);
  });
  return {x: xMax, y: yMax};
}

function getEdgeType(edge, parcelXMaxYMax) {
  let edgeType;
  const xMax = parcelXMaxYMax.xMax
  const yMax = parcelXMaxYMax.yMax
  const isVertical = edgeIsVertical(edge);
  if (isVertical) {
    if (edge[0].x === xMax) {
      edgeType = 'right'
    } else {
      edgeType = 'left'
    }
  } else {
    if (edge[0].y === yMax) {
      edgeType = 'top'
    } else {
      edgeType = 'bottom'
    }
  }
  return edgeType;
}

// For each point of each edge segment, add center coords corresponding to intersecting edge.
function addCrossPointCenter(polygon) {
	const borderArray = Array.from(polygon.border);

	for (let i = 0; i < borderArray.length; i++) {
		const border = borderArray[i];
		const edge = JSON.parse(border.edge);
		const startPoint = edge[0];
		const endPoint = edge[1];
		
		for (let j = i+1; j < borderArray.length; j++) {
			const border2 = borderArray[j];
			const edge2 = JSON.parse(border2.edge);
			const startPoint2 = edge2[0];
			const endPoint2 = edge2[1];

			// Check if border2 is perpendicular to border
			if (edgeIsVertical(edge) !== edgeIsVertical(edge2)) {
			  // crossEdgeEqualCenter = true, means that the edge center(parcel) is the same as the center of the intersecting edge.
        // Allow a max of one tip: start and one tip: end for each edge. If there is more that one set crossEdgeEqualCenter: true.
				if (arePointsEqual(startPoint, startPoint2)){
          setCrossEdgeEqualCenter(border, border2, 'start');
          setCrossEdgeEqualCenter(border2, border, 'start');
				}
				if (arePointsEqual(startPoint, endPoint2)){
          setCrossEdgeEqualCenter(border, border2, 'start');
          setCrossEdgeEqualCenter(border2, border, 'end');
				}
				if (arePointsEqual(endPoint, startPoint2)){
          setCrossEdgeEqualCenter(border, border2, 'end');
          setCrossEdgeEqualCenter(border2, border, 'start');
				}
				if (arePointsEqual(endPoint, endPoint2)){
          setCrossEdgeEqualCenter(border, border2, 'end');
          setCrossEdgeEqualCenter(border2, border, 'end');
				}
			}
		}
	}
}

// Set Boolean value of crossEdgeEqualCenter for crossing edge points
function setCrossEdgeEqualCenter(firstBorder, secondBorder, tip) {
  if (firstBorder.crossEdgePoints.filter(obj => obj.tip === tip).length === 0) {
    firstBorder.crossEdgePoints.push({tip: tip, crossEdgeEqualCenter: arePointsEqual(firstBorder.center, secondBorder.center)});
  } else {
    firstBorder.crossEdgePoints = firstBorder.crossEdgePoints.filter(obj => obj.tip !== tip);
    firstBorder.crossEdgePoints.push({tip: tip, crossEdgeEqualCenter: true});
  }
}

function arePointsEqual(point1, point2) {
  if(point1.x === point2.x && point1.y === point2.y) {
    return true;
  } else {
    return false;
  }
}

// Offset estates perimeter inwards. Segments displacement and corners corrections.
function offsetEstatesPerimeter(allPolygons) {
  const offset = 1;
  allPolygons.forEach(polygon => {
    polygon.border?.forEach(edge => {
      const edgeStart = edge.edge[0];
      const edgeEnd = edge.edge[1];
      const xMax = edge.maxValues.x;
      const yMax = edge.maxValues.y;
      switch (edge.edgeType) {
        case 'top':
          // Inward offset
          edgeStart.y = edgeStart.y - offset;
          edgeEnd.y = edgeEnd.y - offset;
          // Corners corection
          edge.crossEdgePoints.forEach((point) => {
            // point.crossEdgeEqualCenter = true, means the intersecting edge corresponds to the same center. The edge must shrink in size on this tip.
            // point.crossEdgeEqualCenter = false, means the intersecting edge corresponds to other center. The edge must grow in size on this tip.
            if (point.crossEdgeEqualCenter) {
              // Shrink tip
              if (point.tip === 'start') {
                if (edgeStart.x === xMax) {
                  edgeStart.x = edgeStart.x - offset;
                } else {
                  edgeStart.x = edgeStart.x + offset;
                }
              }
              if (point.tip === 'end') {
                if (edgeEnd.x === xMax) {
                  edgeEnd.x = edgeEnd.x - offset;
                } else {
                  edgeEnd.x = edgeEnd.x + offset;
                }
              }
            } else {
              // Grow tip
              if (point.tip === 'start') {
                if (edgeStart.x === xMax) {
                  edgeStart.x = edgeStart.x + offset;
                } else {
                  edgeStart.x = edgeStart.x - offset;
                }
              }
              if (point.tip === 'end') {
                if (edgeEnd.x === xMax) {
                  edgeEnd.x = edgeEnd.x + offset;
                } else {
                  edgeEnd.x = edgeEnd.x - offset;
                }
              }
            }
          });
          break;
        case 'right':
          // Inward offset
          edgeStart.x = edgeStart.x - offset;
          edgeEnd.x = edgeEnd.x - offset;
          // Corners corection
          edge.crossEdgePoints.forEach((point) => {

            if (point.crossEdgeEqualCenter) {
              // Shrink tip
              if (point.tip === 'start') {
                if (edgeStart.y === yMax) {
                  edgeStart.y = edgeStart.y - offset;
                } else {
                  edgeStart.y = edgeStart.y + offset;
                }
              }
              if (point.tip === 'end') {
                if (edgeEnd.y === yMax) {
                  edgeEnd.y = edgeEnd.y - offset;
                } else {
                  edgeEnd.y = edgeEnd.y + offset;
                }
              }
            } else {
              // Grow tip
              if (point.tip === 'start') {
                if (edgeStart.y === yMax) {
                  edgeStart.y = edgeStart.y + offset;
                } else {
                  edgeStart.y = edgeStart.y - offset;
                }
              }
              if (point.tip === 'end') {
                if (edgeEnd.y === yMax) {
                  edgeEnd.y = edgeEnd.y + offset;
                } else {
                  edgeEnd.y = edgeEnd.y - offset;
                }
              }
            }
          });
          break;
        case 'bottom':
          // Inward offset
          edgeStart.y = edgeStart.y + offset;
          edgeEnd.y = edgeEnd.y + offset;
          // Corners corection
          edge.crossEdgePoints.forEach((point) => {

            if (point.crossEdgeEqualCenter) {
              // Shrink tip
              if (point.tip === 'start') {
                if (edgeStart.x === xMax) {
                  edgeStart.x = edgeStart.x - offset;
                } else {
                  edgeStart.x = edgeStart.x + offset;
                }
              }
              if (point.tip === 'end') {
                if (edgeEnd.x === xMax) {
                  edgeEnd.x = edgeEnd.x - offset;
                } else {
                  edgeEnd.x = edgeEnd.x + offset;
                }
              }
            } else {
              // Grow tip
              if (point.tip === 'start') {
                if (edgeStart.x === xMax) {
                  edgeStart.x = edgeStart.x + offset;
                } else {
                  edgeStart.x = edgeStart.x - offset;
                }
              }
              if (point.tip === 'end') {
                if (edgeEnd.x === xMax) {
                  edgeEnd.x = edgeEnd.x + offset;
                } else {
                  edgeEnd.x = edgeEnd.x - offset;
                }
              }
            }
          });
          break;
        case 'left':
          // Inward offset
          edgeStart.x = edgeStart.x + offset;
          edgeEnd.x = edgeEnd.x + offset;
          // Corners corection
          edge.crossEdgePoints.forEach((point) => {

            if (point.crossEdgeEqualCenter) {
              // Shrink tip
              if (point.tip === 'start') {
                if (edgeStart.y === yMax) {
                  edgeStart.y = edgeStart.y - offset;
                } else {
                  edgeStart.y = edgeStart.y + offset;
                }
              }
              if (point.tip === 'end') {
                if (edgeEnd.y === yMax) {
                  edgeEnd.y = edgeEnd.y - offset;
                } else {
                  edgeEnd.y = edgeEnd.y + offset;
                }
              }
            } else {
              // Grow tip
              if (point.tip === 'start') {
                if (edgeStart.y === yMax) {
                  edgeStart.y = edgeStart.y + offset;
                } else {
                  edgeStart.y = edgeStart.y - offset;
                }
              }
              if (point.tip === 'end') {
                if (edgeEnd.y === yMax) {
                  edgeEnd.y = edgeEnd.y + offset;
                } else {
                  edgeEnd.y = edgeEnd.y - offset;
                }
              }
            }
          });
          break;
      }
    })
  })
}

function centerToVertices(center /* {"x":0, "y":0} */) {
  let x = center.x + mapSize
  let y = center.y + mapSize
  x = x * parcelSize
  y = y * parcelSize
  return [{"x": x,"y": y},{"x": x+parcelSize,"y": y},{"x": x+parcelSize,"y": y+parcelSize},{"x": x,"y": y+parcelSize}]
}
function centerToTilePolygon(center /* {"x":0, "y":0} */) {
  let x = center.x + mapSize
  let y = center.y + mapSize
  x = x * parcelSize
  y = y * parcelSize
  return [{"x": x,"y": y},{"x": x+parcelSize,"y": y},{"x": x+parcelSize,"y": y+parcelSize},{"x": x,"y": y+parcelSize},{"x": x,"y": y}]
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
  const perimetersJSON = [];
  const areasJSON = [];
  polygons.forEach(polygon => {
    if (polygon.geoType === 'perimeter') {
      const perimeterJSON = generatePerimeterJson(polygon);
      perimetersJSON.push(perimeterJSON);
    } else if (polygon.geoType === 'area') {
      const areaJSON = generateAreaJson(polygon);
      areasJSON.push(areaJSON);
    }
  })
  
  if (perimetersJSON.length > 0) {
    const estatesPerimeterJson = JSON.stringify({"type":"FeatureCollection", "crs": {"type": "name", "properties": {"name": "ESTATES"}}, "features":perimetersJSON}, null, 0);
    fs.writeFileSync('./output/estatesPerimeter.json', estatesPerimeterJson);
    console.log("Estates Perimeter JSON created");
  }
  if (areasJSON.length > 0) {
    const estatesAreaJson = JSON.stringify({"type":"FeatureCollection", "crs": {"type": "name", "properties": {"name": "ESTATES"}}, "features":areasJSON}, null, 0);
    fs.writeFileSync('./output/estatesArea.json', estatesAreaJson);
    console.log("Estates Area JSON created");
  }
}

function generatePerimeterJson(polygon) {
  let borderArray = [];
  polygon.border.forEach(item => borderArray.push(item.edge));
  var result = borderArray.map((edge_str) => {
    [A, B] = JSON.parse(edge_str);
    return [[A.x, A.y], [B.x, B.y]];
  })
  const feature = {
    "type":"Feature",
    "properties": {"estateId": polygon.estateId , "type": polygon.type, "name": polygon.name, "featureType": "estatePerimeter"},
    "geometry": {"type":"MultiLineString","coordinates":result}
  };
  return feature;
}

function generateAreaJson(polygon) {
  const wrapersArray = [];
  
  polygon.multiPolygon.forEach(tilePolygon => {
    const containerWraper = [];
    const pointsContainer = [];
    tilePolygon.polygon.forEach (point => {
      pointsContainer.push([point.x, point.y]);
    });
    containerWraper.push(pointsContainer);
    wrapersArray.push(containerWraper);
  });
  
  const feature = {
    "type":"Feature",
    "properties": {"estateId": polygon.estateId , "type": polygon.type, "name": polygon.name, "featureType": "estateArea"},
    "geometry": {"type":"MultiPolygon","coordinates":wrapersArray}
  };
  return feature;
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
function drawPolygon({vertices, centers, border, estateId}) {
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
  normBorder.map(([A, B]) => {
    const dx = B.x - A.x;
    const dy = B.y - A.y;

    ctx.beginPath();
    ctx.moveTo(A.x*drawScale+100, A.y*drawScale+100);
    ctx.lineTo(B.x*drawScale+100, B.y*drawScale+100);
    ctx.closePath();
    ctx.stroke();
  });
  // save image
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync('./image.png', buffer);
  console.log('estate id=',estateId);
}


function mockEstate() {
  return JSON.parse('{"nft":{"id":"0x959e104e1a4db6317fa58f8295f586e1a978c297-3847","tokenId":"3847","contractAddress":"0x959e104e1a4db6317fa58f8295f586e1a978c297","activeOrderId":"0x7068c5480f4f73895395e216ea32e45d81ae758c4e13f0db43fce0df3d2e3070","openRentalId":null,"owner":"0x3a572361910939dfc230bc010dadc9de7bd3af4b","name":"South  left gate","image":"https://api.decentraland.org/v2/estates/3847/map.png","url":"/contracts/0x959e104e1a4db6317fa58f8295f586e1a978c297/tokens/3847","data":{"estate":{"description":"South  left gate!","size":13,"parcels":[{"x":-2,"y":-150},{"x":-2,"y":-144},{"x":-2,"y":-143},{"x":-2,"y":-142},{"x":-1,"y":-150},{"x":-1,"y":-149},{"x":-1,"y":-148},{"x":-1,"y":-147},{"x":-1,"y":-146},{"x":-1,"y":-145},{"x":-1,"y":-144},{"x":-1,"y":-143},{"x":-1,"y":-142}]}},"issuedId":null,"itemId":null,"category":"estate","network":"ETHEREUM","chainId":1,"createdAt":1601652467000,"updatedAt":1663477751000,"soldAt":0},"order":{"id":"0x7068c5480f4f73895395e216ea32e45d81ae758c4e13f0db43fce0df3d2e3070","marketplaceAddress":"0x8e5660b4ab70168b5a6feea0e0315cb49c8cd539","contractAddress":"0x959e104e1a4db6317fa58f8295f586e1a978c297","tokenId":"3847","owner":"0x3a572361910939dfc230bc010dadc9de7bd3af4b","buyer":null,"price":"1755001000000000000000000","status":"open","network":"ETHEREUM","chainId":1,"expiresAt":1671667200000,"createdAt":1643357946000,"updatedAt":1643357946000},"rental":null}')
}

/* -------------------------------------------------------------------------- */
/*                          Points Of Interest START                          */
/* -------------------------------------------------------------------------- */

function updatePOIsData() {
  // Fetch POIs coords
  fetch(coordsEndpoint)
  .then(res => res.json())
  .then(data => {
      const rawPoiLocations = data;
      const POIsFound = data.length;
      logMessage('\n/* --------------------------- Points Of Interest --------------------------- */')
      logMessage(`POIs found: ${POIsFound}`);

      /* --------------------------- Remove invalid POIs -------------------------- */
      invalidPOIs.forEach(poi => {
          const indexOfPOI = rawPoiLocations.indexOf(poi);
          rawPoiLocations.splice(indexOfPOI, 1);
      });
      logMessage(`Invalid POIs: ${POIsFound - rawPoiLocations.length}`);
      logMessage(`POIs remained: ${rawPoiLocations.length}`);
      const POIsObjects = formatPoiLocations(rawPoiLocations);

      /* ------------------------- Build metaDataEndPoints ------------------------ */
      // POIs metaData EndPoint has a limit response of 100 element. We need to split the request to obtain all the elements.

      const requestLimit = 100;
      const metadataRequests = [];
      const numRequests = Math.ceil(rawPoiLocations.length / requestLimit);

      for (let i = 0; i < numRequests; i++) {
          let metaDataEndpoint = metaDataBaseURL;

          const start = i * requestLimit;
          const end = Math.min(start + requestLimit, rawPoiLocations.length);

          for (let j = start; j < end; j++) {
              const poi = POIsObjects[j];
              metaDataEndpoint = metaDataEndpoint.concat(`&positions=${poi.lon}%2C${poi.lat}`);
          }

          metadataRequests.push(fetch(metaDataEndpoint).then(res => res.json()).then(data => data.data));
      }

      /* --------------------------- Fetch POIs metaData -------------------------- */
      Promise.all(metadataRequests)
      .then((responses) => {
          const POIsMetaData = [].concat(...responses);
          /* ----------------------------- Add POIs names ----------------------------- */
          addPOIsNames(rawPoiLocations, POIsMetaData, POIsObjects);

          /* ----------------------------- Remove POIs with no name ----------------------------- */
          const remainedPOIs = removePOIsWithNoName(POIsObjects);

          /* ---------------------- Export POIs data in JSON file pois.json --------------------- */
          const POIsData = {
            title: 'POIsData',
            data: remainedPOIs,
          }
          exportJSON(POIsData);
      })
      .catch(err => logMessage(err));
  })
  .catch(err => logMessage(err));
}

function formatPoiLocations(rawPoiLocations) {
  const POIs = [];
  rawPoiLocations.forEach(element => {
      const locationString = element.split(',');
      const locationNumber = locationString.map(coord => {
          return parseInt(coord);
      })
      POIs.push({
          lon: locationNumber[0],
          lat: locationNumber[1],
      })
  });
  return POIs;
}

function addPOIsNames(rawPoiLocations, POIsMetaData, POIsObjects) {
  for (let i = 0; i < POIsObjects.length; i++) {
      const location = rawPoiLocations[i];
      
      POIsMetaData.forEach(element => {
          const POIfound = element.positions.find(e => e === location);
          
          if (POIfound) {
              POIsObjects[i].name = element.title;
          }
      });
  }
}

function removePOIsWithNoName(POIsObjects) {
  const filteredPOIsObjects = POIsObjects.filter(poi => {
    if (!poi.name) {
      logMessage(`Eliminated POI with no name at (${poi.lon}, ${poi.lat})`);
      return false
    }
    return true;
  });
  logMessage(`POIs remained: ${filteredPOIsObjects.length}`);
  console.log('  # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #');
  return filteredPOIsObjects;
}

function readInvalidPOIsList() {
  const fs = require('fs');
  const invalidPOIs = fs.readFileSync('./input/invalidPOIsList.txt', 'utf8');
  const invalidPOIsArray = invalidPOIs.split('\n');
  return invalidPOIsArray
}

function exportJSON(data) {
  const jsonData = JSON.stringify(data);
  const fs = require('fs');

  fs.writeFile('./output/pois.json', jsonData, (err) => {
  if (err) throw err;
  logMessage('POIsData saved to file ./output/pois.json!');
  });
}

/* -------------------------------------------------------------------------- */
/*                           Points Of Interest END                           */
/* -------------------------------------------------------------------------- */
