// Express 기본 모듈 불러오기
var express = require('express'), http = require('http'), path = require('path');

// const asyncify = require('express-asyncify');
// const router = asyncify(express.Router());

// Express의 미들웨어 불러오기
var bodyParser = require('body-parser'), cookieParser = require('cookie-parser'), expressSession = require('express-session'), errorHandler = require('errorhandler');
var fs = require('fs'); // 파일목록 탐색
var pm2 = require('pm2');
var dao = require('./dao');

var common = require('./common');
var smtp = require('./smtp');
var redis = require('./redis');
var routers = require('./routers');
// 익스프레스 객체 생성
var app = express();

var router = express.Router();

var net = require('net');
var helmet = require('helmet');

var HttpStatus = require('http-status-codes');
var client = new net.Socket();

// csrf셋팅
var csrf = require('csurf');
var csrfProtection = csrf({cookie : true});

var serverSwitch = false;

client.on('close', function() {
	serverSwitch = false;
	console.log("server off");
});
// ===== 뷰 엔진 설정 =====//
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');
// body-parser를 이용해 application/x-www-form-urlencoded 파싱
app.use(bodyParser.urlencoded({
	extended : false
}));
// body-parser를 이용해 application/json 파싱
app.use(bodyParser.json());
// cookie-parser 설정
app.use(cookieParser());
// session객체 설정
app.use(expressSession({
	secret : 'my key',
	resave : true,
	saveUninitialized : true
}));

// 시큐어 코딩
// helmet => http 헤더 9개 설정 조작
// X-Frame-Options헤더 설정
app.use(helmet.frameguard());
// 웹 브라우저에서 xss필터 사용
app.use(helmet.xssFilter());
// 선언 콘텐츠 이외의 응답에대한 MIME가로채기 방지
app.use(helmet.noSniff());
// 클라이언트 캐싱 방지
app.use(helmet.noCache());

app.disable('x-powered-by'); // => app.use(helmet.hidePoweredBy());

var cssSheet = {
	style : fs.readFileSync('views/style.css', 'utf8')
};

//기본 Path
app.get('/', (req, res) => {

	res.render('index', {
		myCss : cssSheet
	});
});

function XSSFilter(content) {
	return content.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

app.use((req, res, next) => { // 미들웨어
	console.log("middle");
	//console.log(req.url);
	if(req.method === 'POST' || req.method === 'PUT') {
		for(key in req.body) {
			req.body[key] = XSSFilter(req.body[key]);
		}
	}
	
	next();
});

app.use((err, req, res, next) => { // 에러 처리 부분
	console.log("err stack");
	console.error(err.stack); // 에러 메시지 표시
	res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('INTERNAL_SERVER_ERROR'); // 500 상태 표시 후 에러 메시지 전송
});

//라우터 등록
app.use('/', router);
app.use('/', routers);
// 예외화면
app.all('*', (req, res) => {
	res.status(HttpStatus.NOT_FOUND).send('<h1>Page Not Found</h1>');
});

// pm2 연결
pm2.connect(function(err) {
});

//서버 파일 디렉토리
var directory;
var exelocation;

// 설정파일 읽어들이기
fs.readFile('conf.properties', 'utf8', function(err, data) {
	var json = JSON.parse(data);
	exelocation = json.exelocation;
	directory = json.directory;
	console.log("exelocation : " + exelocation);
	console.log("directory : " + directory);
	// node js listen port는 설정파일에 있다
	app.listen(json.nodeport, function() {
		console.log('application listening on port ' + json.nodeport + '!');
	});

});

// 메모리 CPU 모니터
router.get('/monitor', (req, res) => {

	pm2.describe("Server.exe", (err, des) => {
		res.send(des);
	});
});

// 서버 on/off기능 라우터
router.put('/serverSwitch', (req, res) => {
	if (req.session.user) { // 세선정보 있음
		if (req.body.off === "1") { // 서버켜기

			pm2.start(exelocation, {
				name : "Server.exe",
				watch : true,
				autorestart : false,
				output : "stdout.log" // Server의 stdout로그파일
			}, function(err, apps) {
				// 채팅서버는 같은 PC에서 동작한다
				// 서버 on 후에 연결한다
				console.log("server on");
				client.connect(1234, 'localhost');
				serverSwitch = true;

				res.send({
					flag : 0
				});

				smtp.sendMail("서버켜짐!");
			});
		} else {
			serverSwitch = false;
			// client.destroy();
			//		
			// pm2.delete("Server.exe", function(err, des) {
			// res.send({flag:1});
			// });
			pm2.stop("Server.exe", function(err) {

			});
			var packet = Buffer.alloc(20);
			// 0 2번째 short 바디사이즈
			packet[0] = 20;
			// 6 10번째 direction
			packet[6] = common.EXIT; // direction = > USERCNT
			client.write(packet, function() {
				client.destroy();
			});
			res.send({
				flag : 1
			});

			smtp.sendMail("서버꺼짐!");
		}
	} else {
		res.status(HttpStatus.UNAUTHORIZED).send({});
	}
});


// 로그인 router
router.post('/login', async (req, res) => {

	try {
		
		let data = await dao.selectId(req.body);

		if (data.length > 0) {
			console.log("login okey");
			// 세션저장
			req.session.user = {
				userid : data[0].userid,
				nickname : data[0].nickname,
				lastlogdate : data[0].lastlogdate,
				adminyn : data[0].adminyn
			};
			res.status(HttpStatus.OK).send(data);
		} else {
			console.log("login fail");
			res.status(HttpStatus.OK).send(data);
		}
	} catch (err) {
		console.log("DB Error " + err);
		res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(err);
	}
});

// 로그아웃 router
router.get('/logout', (req, res) => {

	if (req.session.user) {

		req.session.destroy(function(err) {
			res.render('index', {
				myCss : cssSheet
			});
		});
	} else {
		res.render('index', {
			myCss : cssSheet
		});
	}
});

// 메인화면 router
router.get('/main', (req, res) => {
	if (req.session.user) { // 세선정보 있음

		if (req.session.user.adminyn === 1) {

			res.render('main', {
				myCss : cssSheet,
				nickname : req.session.user.nickname,
				lastlogdate : req.session.user.lastlogdate.substr(0, 10),
				lastlogtime : req.session.user.lastlogdate.substr(11, 8)
			});
		} else {
			res.render('construction', {
				myCss : cssSheet
			});
		}

	} else { // 세션정보 없음
		res.status(HttpStatus.UNAUTHORIZED).send({});
	} 
});

// 관리자화면 로딩시 서버 on off 상태 확인
router.get('/initButton', (req, res) => {
	pm2.describe("Server.exe", function(err, des) {
		if (!common.gfn_isNull(des[0])) {
			var json = {
				"status" : des[0].pm2_env.status
			};
			res.status(HttpStatus.OK).send(json);
		} else {
			var json2 = {
				"status" : "none"
			};
			res.status(HttpStatus.OK).send(json2);
		}

	});
});

// 멤버 강퇴
router.delete('/ban/:banName', (req, res) => {
	if (req.session.user) { // 세선정보 있음
		var banName = Buffer.from(req.params.banName);
		// Chatting Server의 Packet유형으로 전달한다
		var packet = Buffer.alloc(banName.length + 10);
		// 0 2번째 short 바디사이즈
		packet[0] = banName.length + 10;
		// 2 6번째 status = > 이름길이
		packet[2] = banName.length;
		// 6 10번째 direction
		packet[6] = common.BAN; // direction
		for (var i = 0; i < banName.length; i++) {
			packet[i + 10] = banName[i]; // msg
		}
		client.write(packet, function() {
			var data = {};
			res.status(HttpStatus.OK).send(data);
		});
	} else {
		res.status(HttpStatus.UNAUTHORIZED).send({});
	}
});


// 로그인 유저수
router.get('/callCount', (req, res) => {
	if (req.session.user) { // 세선정보 있음
		if (serverSwitch) { // 서버 켜진 상태

			var packet = Buffer.alloc(20);
			// 0 2번째 short 바디사이즈
			packet[0] = 20;
			// 6 10번째 direction
			packet[6] = common.CALLCOUNT; // direction = > USERCNT
			client.write(packet, function() {
			});
			// send

			client.on('data', function(data) {
				// data라는 event를 임시 add 해줬으므로 다쓰고 없앤다
				var bodySize = data.slice(0, 2).readUInt8();
				var packetCnt = data.slice(10, bodySize - 1);

				try {
					var json1 = JSON.parse(packetCnt.toString('utf-8'));
					res.status(HttpStatus.OK).send(json1);
				} catch (err) {
					var json2 = {
						"packet" : 0,
						"cnt" : 0
					};
					res.status(HttpStatus.OK).send(json2);
				}
				client.removeAllListeners('data');
			});
			// recv
		} else { // 서버 꺼진 상태
			var arr = {
				'cnt' : 0,
				'packet' : "0"
			};
			res.status(HttpStatus.OK).send(arr);
		}
	}
});

// 서버의 파일 확인
router.get('/file', (req, res) => {
	if (req.session.user) { // 세선정보 있음
		var fs = require('fs');

		fs.readdir(directory, function(error, filelist) {
			res.status(HttpStatus.OK).send(filelist);
		});
	} else {
		res.status(HttpStatus.FORBIDDEN).send({});
	}
});

// 파일 다운로드
router.get('/fileDown/:name', (req, res) => {
	if (req.session.user) { // 세선정보 있음
		var orgName = req.params.name;
	
		var fileDir = directory + "/" + orgName;
		fs.exists(fileDir, function(exist) {

			if(exist) {
				res.status(HttpStatus.OK).download(fileDir);		
			} else {
				res.status(HttpStatus.NOT_FOUND).send('file not exist');
			}
		})
	} else {
		res.status(HttpStatus.FORBIDDEN).send({});
	}
});

//파일 삭제
router.delete('/fileDelete/:name', (req, res) => {
	if (req.session.user) { // 세선정보 있음
		var orgName = req.params.name;
		var fileDir = directory + "/" + orgName;
	
		fs.exists(fileDir, function(exist) {

			if(exist) {
				fs.unlink(fileDir, (err) => {
					if(err) {
						throw err;
					}
					console.log('file deleted');
					res.status(HttpStatus.OK).send(HttpStatus.OK);
				});		
			} else {
				res.status(HttpStatus.NOT_FOUND).send('file not exist');
			}
		})	
	} else {
		res.status(HttpStatus.FORBIDDEN).send({});
	}
});

var process = require('process');

process.on('uncaughtException', function(err) {
	if(err.code === "ETIMEDOUT") {
		console.error("ETIMEDOUT ", err);
	} else if (err.code === "ECONNREFUSED") {
		console.error('ECONNREFUSED ', err);	
	} else if (err.code === "EHOSTUNREACH") {
		console.error('EHOSTUNREACH ', err);	
	} else {
		console.error('uncaughtException ', err);	
	}
	// smtp.sendMail("예기치 못한 에러" + err);
});

process.on('unhandledRejection' , (reason , p) => {
	console.error(reason, 'Unhandled Rejection at Promise', p);
});

var request = http.request({
	path : "/"
}, function(res) {
	res.on("error", function(err) {
		console.log("error " + err);
	});
});

module.exports = app;