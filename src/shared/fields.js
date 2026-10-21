/**
 * 字段词表 + 匹配用的先验知识。
 *
 * 每个条目描述「简历里的一个可填项」：
 *   aliases   —— 强别名，本字段专有（如「入学时间」只可能属于教育经历）
 *   generic   —— 弱别名，跨区块共享（如「开始时间」在教育/工作/项目里都有）
 *   negative  —— 反向别名，命中就扣分（如「用户名」不应该匹配到姓名）
 *   ac        —— WHATWG autocomplete 标准 token，命中即最高置信度
 *   types     —— 期望的 input type
 *   maxLength —— 期望的 maxlength 区间，作为补充信号
 *
 * 区块（section）用于消歧义：弱别名本身不足以定位，
 * 必须靠所在区块决定它到底属于教育经历还是工作经历。
 */
(function (root) {
  'use strict';

  const RA = root.RA;

  /** 日期类字段在经历块里共享的弱别名 */
  const DATE_START_GENERIC = [
    '开始时间', '起始时间', '开始日期', '起始日期', '起止时间', '起止日期',
    '开始', '起始', 'from', 'start', 'startdate', 'begindate', 'begin',
  ];
  // 「起止时间」同时给 start 和 end：一个表单项里放两个日期控件、标签只写
  // 「起止时间」的布局很常见，靠「一个槽位只能占一次」把第二个分给结束时间。
  const DATE_END_GENERIC = [
    '结束时间', '终止时间', '结束日期', '终止日期', '截止时间', '起止时间', '起止日期',
    '结束', '终止', '至', 'to', 'end', 'enddate', 'todate', 'finish',
  ];

  const DEFS = [
    // ───────────────────────────── 基本信息 ─────────────────────────────
    {
      key: 'basic.name', section: 'basic', label: '姓名',
      aliases: ['姓名', '真实姓名', '中文姓名', '本人姓名', '申请人姓名', '名字'],
      generic: ['name', 'fullname', 'full name', 'realname', 'yourname', 'applicantname'],
      // 「用户名 / 昵称 / 公司名称」这些含 name 但不是姓名，必须压下去
      negative: ['用户名', '昵称', '账号', '帐号', '公司名称', '企业名称', '学校名称',
        '项目名称', '文件名称', '联系人', '紧急联系人', '监护人', '英文名',
        'username', 'nickname', 'account', 'companyname', 'schoolname', 'projectname', 'filename'],
      ac: ['name'],
      types: ['text'],
    },
    {
      key: 'basic.nameEn', section: 'basic', label: '英文名',
      aliases: ['英文名', '英文姓名', '拼音', '拼音姓名', 'englishname'],
      generic: [],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'basic.gender', section: 'basic', label: '性别',
      aliases: ['性别'],
      generic: ['gender', 'sex'],
      negative: [],
      ac: ['sex'],
      types: ['text', 'select', 'radio'],
    },
    {
      key: 'basic.birthday', section: 'basic', label: '出生日期',
      aliases: ['出生日期', '出生年月', '出生年份', '生日', '出生'],
      generic: ['birthday', 'birth', 'birthdate', 'dob', 'dateofbirth', 'bday'],
      negative: ['入学', '毕业', '入职', '离职', '工作'],
      ac: ['bday'],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'basic.age', section: 'basic', label: '年龄',
      aliases: ['年龄'],
      generic: ['age'],
      negative: [],
      ac: [],
      types: ['text', 'number', 'select'],
      maxLength: [1, 3],
    },
    {
      key: 'basic.phone', section: 'basic', label: '手机号',
      aliases: ['手机号', '手机号码', '手机', '移动电话', '联系电话', '联系方式', '电话'],
      generic: ['phone', 'mobile', 'cellphone', 'telephone', 'tel', 'contactnumber', 'phonenumber'],
      negative: ['座机', '固话', '验证码', '短信', '分机', '区号', '紧急联系电话', '家庭电话'],
      ac: ['tel', 'tel-national', 'tel-local'],
      types: ['tel', 'text', 'number'],
      maxLength: [11, 13],
    },
    {
      key: 'basic.email', section: 'basic', label: '邮箱',
      aliases: ['电子邮箱', '电子邮件', '邮箱地址', '邮箱', '邮件'],
      generic: ['email', 'mail', 'e mail', 'emailaddress'],
      negative: [],
      ac: ['email'],
      types: ['email', 'text'],
    },
    {
      key: 'basic.idCard', section: 'basic', label: '身份证号',
      aliases: ['身份证号', '身份证号码', '身份证', '证件号码', '证件号', '身份证件号'],
      generic: ['idcard', 'idnumber', 'identitycard', 'cardno', 'cardnumber'],
      negative: ['银行卡', '学号', '工号', '证书编号'],
      ac: [],
      types: ['text'],
      // 18 位是硬特征，几乎零成本且极准
      maxLength: [15, 18],
    },
    {
      key: 'basic.city', section: 'basic', label: '现居城市',
      aliases: ['现居城市', '所在城市', '当前城市', '现居住地', '居住城市', '所在地区', '现居地'],
      generic: ['city', 'currentcity', 'location'],
      negative: ['期望', '意向', '籍贯', '出生地', '学校', '公司'],
      ac: ['address-level2'],
      types: ['text', 'select'],
    },
    {
      key: 'basic.address', section: 'basic', label: '详细地址',
      aliases: ['详细地址', '居住地址', '现住址', '通讯地址', '联系地址'],
      generic: ['address', 'streetaddress', 'addressline1', 'addr'],
      negative: ['邮箱', '邮件', '网址', 'ip'],
      ac: ['street-address', 'address-line1'],
      types: ['text', 'textarea'],
    },
    {
      key: 'basic.hometown', section: 'basic', label: '籍贯',
      // 「户籍/户口」拆出去给了 basic.hukou——两者在中国人事表里是两个不同的格子
      aliases: ['籍贯', '祖籍', '老家'],
      generic: ['hometown', 'nativeplace'],
      negative: ['户籍', '户口'],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'basic.nationality', section: 'basic', label: '国籍',
      aliases: ['国籍', '国家地区'],
      generic: ['nationality', 'country'],
      negative: [],
      ac: ['country-name', 'country'],
      types: ['text', 'select'],
    },
    {
      key: 'basic.ethnicity', section: 'basic', label: '民族',
      aliases: ['民族'],
      generic: ['ethnicity', 'ethnic', 'nation'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'basic.politicalStatus', section: 'basic', label: '政治面貌',
      aliases: ['政治面貌', '政治面貌情况'],
      generic: ['politicalstatus', 'political'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'basic.maritalStatus', section: 'basic', label: '婚姻状况',
      aliases: ['婚姻状况', '婚姻状态', '婚否'],
      generic: ['maritalstatus', 'marriage', 'marital'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'basic.height', section: 'basic', label: '身高',
      aliases: ['身高'],
      generic: ['height'],
      negative: [],
      ac: [],
      types: ['text', 'number', 'select'],
      maxLength: [2, 3],
    },
    {
      key: 'basic.weight', section: 'basic', label: '体重',
      aliases: ['体重'],
      generic: ['weight'],
      negative: [],
      ac: [],
      types: ['text', 'number', 'select'],
      maxLength: [2, 3],
    },
    {
      key: 'basic.wechat', section: 'basic', label: '微信',
      aliases: ['微信号', '微信'],
      generic: ['wechat', 'weixin'],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'basic.qq', section: 'basic', label: 'QQ',
      aliases: ['qq号'],
      generic: ['qq'],
      negative: [],
      ac: [],
      types: ['text', 'number'],
    },
    {
      key: 'basic.website', section: 'basic', label: '个人主页',
      aliases: ['个人主页', '个人网站', '博客', '作品集', 'github'],
      generic: ['website', 'homepage', 'blog', 'portfolio', 'url'],
      negative: [],
      ac: ['url'],
      types: ['text', 'url'],
    },
    {
      key: 'basic.postalCode', section: 'basic', label: '邮编',
      aliases: ['邮政编码', '邮编'],
      generic: ['postalcode', 'zipcode', 'zip'],
      negative: [],
      ac: ['postal-code'],
      types: ['text', 'number'],
      maxLength: [6, 6],
    },
    {
      key: 'basic.selfEvaluation', section: 'basic', label: '自我评价',
      aliases: ['自我评价', '自我介绍', '个人评价', '个人简介', '个人优势'],
      generic: ['selfevaluation', 'selfintroduction', 'aboutme', 'summary', 'introduction'],
      negative: [],
      ac: [],
      types: ['textarea'],
    },
    {
      key: 'basic.skills', section: 'basic', label: '技能特长',
      aliases: ['技能特长', '专业技能', '技能', '擅长技能'],
      generic: ['skills', 'skill', 'expertise'],
      negative: [],
      ac: [],
      types: ['textarea', 'text'],
    },

    // ── 基本信息：补充常见项 ──
    {
      key: 'basic.formerName', section: 'basic', label: '曾用名',
      aliases: ['曾用名', '曾用姓名'],
      generic: ['formername'],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'basic.birthPlace', section: 'basic', label: '出生地',
      aliases: ['出生地', '出生城市', '出生省份', '出生地点'],
      generic: ['birthplace'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'basic.hukou', section: 'basic', label: '户口所在地',
      aliases: ['户口所在地', '户籍所在地', '户籍地', '户口所在地区', '户口'],
      generic: ['hukou', 'householdregistration'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'basic.phoneAlt', section: 'basic', label: '备用电话',
      aliases: ['备用电话', '备用手机', '其他电话', '第二联系电话'],
      generic: ['alternatephone', 'phonealt'],
      negative: [],
      ac: [],
      types: ['tel', 'text'],
      maxLength: [11, 13],
    },
    {
      key: 'basic.emailAlt', section: 'basic', label: '备用邮箱',
      aliases: ['备用邮箱', '第二邮箱', '其他邮箱'],
      generic: ['alternateemail', 'emailalt'],
      negative: [],
      ac: [],
      types: ['email', 'text'],
    },
    {
      key: 'basic.addressProvince', section: 'basic', label: '所在省份',
      aliases: ['所在省份', '现居省份', '居住省份', '联系省份'],
      generic: ['province', 'addresslevel1'],
      negative: ['户籍', '户口', '籍贯', '出生'],
      ac: ['address-level1'],
      types: ['text', 'select'],
    },
    {
      key: 'basic.addressDistrict', section: 'basic', label: '所在区县',
      aliases: ['所在区县', '现居区县', '居住区县', '所在区域'],
      generic: ['district', 'county', 'addresslevel3'],
      negative: ['户籍', '户口'],
      ac: ['address-level3'],
      types: ['text', 'select'],
    },
    {
      key: 'basic.healthStatus', section: 'basic', label: '健康状况',
      aliases: ['健康状况', '身体状况'],
      generic: ['healthstatus', 'health'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'basic.workYears', section: 'basic', label: '工作年限',
      aliases: ['工作年限', '从业年限', '工作年份', '参加工作时间'],
      generic: ['workyears', 'yearsofexperience', 'experience'],
      negative: [],
      ac: [],
      types: ['text', 'number', 'select'],
      maxLength: [1, 3],
    },
    {
      key: 'basic.currentSalary', section: 'basic', label: '当前薪资',
      aliases: ['当前薪资', '目前薪资', '现有薪资', '当前月薪'],
      generic: ['currentsalary', 'presentsalary'],
      negative: ['期望', '意向'],
      ac: [],
      types: ['text', 'number', 'select'],
    },
    {
      key: 'basic.graduateYear', section: 'basic', label: '毕业年份',
      aliases: ['毕业年份', '毕业年度'],
      generic: ['graduationyear'],
      negative: [],
      ac: [],
      types: ['text', 'number', 'select'],
      maxLength: [4, 4],
    },
    {
      key: 'basic.isFreshGraduate', section: 'basic', label: '是否应届生',
      aliases: ['是否应届', '应届生', '是否应届毕业生', '应届毕业生'],
      generic: ['freshgraduate', 'isgraduate'],
      negative: [],
      ac: [],
      types: ['text', 'select', 'radio'],
    },
    {
      key: 'basic.hobbies', section: 'basic', label: '兴趣爱好',
      aliases: ['兴趣爱好', '个人爱好', '业余爱好'],
      generic: ['hobbies', 'interests'],
      negative: [],
      ac: [],
      types: ['text', 'textarea'],
    },
    {
      key: 'basic.idType', section: 'basic', label: '证件类型',
      aliases: ['证件类型', '证件种类', '身份证件类型'],
      generic: ['idtype', 'documenttype'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'basic.schoolEmail', section: 'basic', label: '学校邮箱',
      aliases: ['学校邮箱', '校园邮箱', 'edu邮箱'],
      generic: ['schoolemail', 'campusemail'],
      negative: [],
      ac: [],
      types: ['email', 'text'],
    },
    {
      key: 'basic.homePhone', section: 'basic', label: '家庭电话',
      aliases: ['家庭电话', '住宅电话', '家庭号码'],
      generic: ['homephone', 'hometel'],
      negative: [],
      ac: [],
      types: ['tel', 'text'],
    },

    // ───────────────────────────── 求职意向 ─────────────────────────────
    {
      key: 'jobIntention.position', section: 'jobIntention', label: '期望职位',
      aliases: ['期望职位', '期望岗位', '意向职位', '意向岗位', '求职意向', '应聘职位'],
      generic: ['expectedposition', 'desiredposition', 'jobtitle', 'position'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'jobIntention.city', section: 'jobIntention', label: '期望城市',
      aliases: ['期望城市', '意向城市', '期望工作地', '期望工作地点', '意向地区'],
      generic: ['expectedcity', 'desiredcity'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'jobIntention.salary', section: 'jobIntention', label: '期望薪资',
      aliases: ['期望薪资', '期望月薪', '期望薪水', '薪资要求'],
      generic: ['expectedsalary', 'desiredsalary', 'salaryexpectation'],
      negative: [],
      ac: [],
      types: ['text', 'select', 'number'],
    },
    {
      key: 'jobIntention.jobType', section: 'jobIntention', label: '工作性质',
      aliases: ['工作性质', '求职类型', '工作类型'],
      generic: ['jobtype', 'employmenttype'],
      negative: [],
      ac: [],
      types: ['text', 'select', 'radio'],
    },
    {
      key: 'jobIntention.industry', section: 'jobIntention', label: '期望行业',
      aliases: ['期望行业', '意向行业', '目标行业', '期望从事行业'],
      generic: ['expectedindustry'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'jobIntention.companyType', section: 'jobIntention', label: '期望公司类型',
      aliases: ['期望公司类型', '期望企业类型', '意向公司性质', '期望单位类型'],
      generic: ['expectedcompanytype'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'jobIntention.positionLevel', section: 'jobIntention', label: '期望职级',
      aliases: ['期望职级', '意向职级', '期望级别'],
      generic: ['expectedlevel'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'jobIntention.jobStatus', section: 'jobIntention', label: '求职状态',
      aliases: ['求职状态', '目前求职状态', '求职意向状态'],
      generic: ['jobstatus', 'jobseekingstatus'],
      negative: [],
      ac: [],
      types: ['text', 'select', 'radio'],
    },
    {
      key: 'jobIntention.availableFrom', section: 'jobIntention', label: '到岗时间',
      aliases: ['到岗时间', '可到岗时间', '最快到岗', '可入职时间', '到岗日期'],
      // 「入职时间」不放在强别名里：它在工作经历区块里指的是「上一家的入职时间」，
      // 含义完全不同。这里留作弱别名，靠区块把两者分开。
      generic: ['availablefrom', 'available', 'onboarddate', '入职时间'],
      negative: [],
      ac: [],
      types: ['text', 'select', 'date'],
    },

    // ───────────────────────────── 教育经历 ─────────────────────────────
    {
      key: 'educations.school', section: 'education', label: '学校',
      aliases: ['学校名称', '毕业院校', '毕业学校', '就读学校', '学校', '院校', '学院'],
      generic: ['school', 'university', 'college', 'institution', 'schoolname'],
      negative: ['专业', '公司'],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'educations.major', section: 'education', label: '专业',
      aliases: ['所学专业', '专业名称', '就读专业', '专业'],
      generic: ['major', 'speciality', 'specialty', 'fieldofstudy'],
      negative: ['专业类别', '专业方向'],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'educations.degree', section: 'education', label: '学历',
      aliases: ['学历层次', '最高学历', '学历'],
      generic: ['degree', 'education', 'edulevel', 'qualification'],
      negative: ['学位', '学历类型'],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'educations.startDate', section: 'education', label: '入学时间',
      aliases: ['入学时间', '入学日期', '入校时间', '就读起始时间', '开始就读'],
      generic: DATE_START_GENERIC,
      negative: ['毕业', '离职', '入职'],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'educations.endDate', section: 'education', label: '毕业时间',
      // 「毕业年份」留给了基本信息里的 basic.graduateYear（那是问「你哪年毕业的」，
      // 不是问读研读博的结束月份），这里不重复声明
      aliases: ['毕业时间', '毕业日期', '离校时间', '预计毕业时间'],
      generic: DATE_END_GENERIC,
      negative: ['入学', '入职', '离职'],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'educations.gpa', section: 'education', label: 'GPA',
      aliases: ['绩点', '平均绩点', '成绩'],
      generic: ['gpa', 'grade', 'gradescore'],
      negative: [],
      ac: [],
      types: ['text', 'number'],
    },
    {
      key: 'educations.city', section: 'education', label: '学校所在地',
      aliases: ['学校所在地', '院校所在地'],
      generic: [],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'educations.description', section: 'education', label: '在校经历',
      aliases: ['在校经历', '在校表现', '在校情况'],
      generic: ['schoolexperience'],
      negative: [],
      ac: [],
      types: ['textarea'],
    },
    {
      key: 'educations.schoolType', section: 'education', label: '学校类型',
      aliases: ['学校类型', '院校类型', '学校性质', '院校性质'],
      generic: ['schooltype'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'educations.isFullTime', section: 'education', label: '学习形式',
      // 很多网申把「全日制 / 非全日制」写成「学历类型」「学历性质」，
      // 它问的不是本科/硕士（那是 educations.degree），注意别搞反。
      aliases: ['学习形式', '是否全日制', '培养方式', '就读形式',
        '学历类型', '学历性质', '学习方式', '就读方式', '授课形式', '教育形式'],
      generic: ['studyform', 'fulltime', 'studytype'],
      negative: ['层次', '毕业院校'],
      ac: [],
      types: ['text', 'select', 'radio'],
    },
    {
      key: 'educations.majorCategory', section: 'education', label: '专业类别',
      aliases: ['专业类别', '专业大类', '学科门类'],
      generic: ['majorcategory'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'educations.minorMajor', section: 'education', label: '辅修专业',
      aliases: ['辅修专业', '第二专业', '双学位专业'],
      generic: ['minormajor'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'educations.rank', section: 'education', label: '专业排名',
      aliases: ['专业排名', '年级排名', '班级排名', '综合排名'],
      generic: ['rank', 'ranking'],
      negative: [],
      ac: [],
      types: ['text', 'number'],
    },
    {
      key: 'educations.honors', section: 'education', label: '在校荣誉',
      // 「荣誉奖项」「获奖情况」留给了 award 区块——那些是区块标题，不能同时当字段强别名
      aliases: ['在校荣誉', '奖学金', '所获荣誉'],
      generic: ['honors', 'scholarship'],
      negative: [],
      ac: [],
      types: ['textarea', 'text'],
    },
    {
      key: 'educations.courses', section: 'education', label: '主修课程',
      aliases: ['主修课程', '主要课程', '所学课程'],
      generic: ['courses', 'maincourses'],
      negative: [],
      ac: [],
      types: ['textarea', 'text'],
    },
    {
      key: 'educations.thesisTitle', section: 'education', label: '毕业论文',
      aliases: ['毕业论文', '毕业设计', '论文题目'],
      generic: ['thesis'],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'educations.lab', section: 'education', label: '实验室',
      aliases: ['实验室', '课题组', '研究方向'],
      generic: ['lab', 'laboratory', 'researchgroup'],
      negative: [],
      ac: [],
      types: ['text'],
    },

    // ───────────────────────────── 工作经历 ─────────────────────────────
    {
      key: 'works.company', section: 'work', label: '公司名称',
      aliases: ['公司名称', '公司全称', '单位名称', '任职公司', '所在公司', '公司', '单位'],
      generic: ['company', 'companyname', 'employer', 'organization', 'corp'],
      negative: ['行业', '性质', '规模', '部门'],
      ac: ['organization'],
      types: ['text', 'select'],
    },
    {
      key: 'works.position', section: 'work', label: '职位',
      aliases: ['职位名称', '岗位名称', '担任职位', '所在职位', '职位', '岗位'],
      generic: ['position', 'jobtitle', 'title', 'role', 'post'],
      negative: ['部门', '职级'],
      ac: ['organization-title'],
      types: ['text', 'select'],
    },
    {
      key: 'works.department', section: 'work', label: '部门',
      aliases: ['所在部门', '部门名称', '部门'],
      generic: ['department', 'dept'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'works.startDate', section: 'work', label: '入职时间',
      aliases: ['入职时间', '入职日期', '任职起始时间', '开始任职时间'],
      generic: DATE_START_GENERIC,
      negative: ['入学', '毕业', '离职'],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'works.endDate', section: 'work', label: '离职时间',
      aliases: ['离职时间', '离职日期', '任职结束时间', '结束任职时间'],
      generic: DATE_END_GENERIC,
      negative: ['入学', '毕业', '入职'],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'works.city', section: 'work', label: '工作地点',
      aliases: ['工作地点', '工作城市', '任职地点'],
      generic: [],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'works.salary', section: 'work', label: '薪资',
      aliases: ['薪资', '月薪', '税前月薪', '年薪'],
      generic: [],
      negative: ['期望'],
      ac: [],
      types: ['text', 'number', 'select'],
    },
    {
      key: 'works.description', section: 'work', label: '工作内容',
      aliases: ['工作内容', '工作职责', '主要职责', '工作描述', '岗位职责', '业绩描述'],
      generic: ['jobdescription', 'description', 'duties', 'responsibility'],
      negative: [],
      ac: [],
      types: ['textarea'],
    },
    {
      key: 'works.leaveReason', section: 'work', label: '离职原因',
      aliases: ['离职原因', '辞职原因'],
      generic: ['leavingreason', 'reasonforleaving'],
      negative: [],
      ac: [],
      types: ['text', 'textarea', 'select'],
    },
    {
      key: 'works.industry', section: 'work', label: '所属行业',
      aliases: ['所属行业', '行业类别', '公司行业', '企业行业'],
      generic: ['industry'],
      negative: ['期望', '意向'],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'works.companyType', section: 'work', label: '公司性质',
      aliases: ['公司性质', '企业性质', '单位性质'],
      generic: ['companytype', 'enterprisetype'],
      negative: ['期望', '意向'],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'works.companyScale', section: 'work', label: '公司规模',
      aliases: ['公司规模', '企业规模', '公司人数', '人员规模'],
      generic: ['companyscale', 'companysize'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'works.subordinates', section: 'work', label: '下属人数',
      aliases: ['下属人数', '管理人数', '带领团队人数'],
      generic: ['subordinates', 'managedsize'],
      negative: [],
      ac: [],
      types: ['text', 'number', 'select'],
    },
    {
      key: 'works.reportingTo', section: 'work', label: '汇报对象',
      aliases: ['汇报对象', '直属上级', '汇报上级'],
      generic: ['reportsto'],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'works.stillEmployed', section: 'work', label: '是否在职',
      aliases: ['是否在职', '在职中', '目前在职'],
      generic: ['currentlyemployed', 'stillemployed'],
      negative: [],
      ac: [],
      types: ['text', 'select', 'radio', 'checkbox'],
    },
    {
      key: 'works.achievements', section: 'work', label: '工作业绩',
      aliases: ['工作业绩', '主要业绩', '业绩成果', '工作成果', '主要成就'],
      generic: ['achievements', 'accomplishments'],
      negative: [],
      ac: [],
      types: ['textarea', 'text'],
    },
    {
      key: 'works.employmentType', section: 'work', label: '工作属性',
      aliases: ['工作属性', '工作性质类型', '任职类型'],
      generic: ['employmenttype', 'worktype'],
      negative: [],
      ac: [],
      types: ['text', 'select', 'radio'],
    },

    // ───────────────────────────── 项目经历 ─────────────────────────────
    {
      key: 'projects.name', section: 'project', label: '项目名称',
      aliases: ['项目名称', '项目名'],
      generic: ['projectname', 'project'],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'projects.role', section: 'project', label: '项目角色',
      aliases: ['项目角色', '担任角色', '项目职务'],
      generic: ['projectrole', 'roleinproject'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'projects.startDate', section: 'project', label: '项目开始时间',
      aliases: ['项目开始时间', '项目起始时间'],
      generic: DATE_START_GENERIC,
      negative: ['入学', '毕业', '入职', '离职'],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'projects.endDate', section: 'project', label: '项目结束时间',
      aliases: ['项目结束时间', '项目截止时间'],
      generic: DATE_END_GENERIC,
      negative: ['入学', '毕业', '入职', '离职'],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'projects.description', section: 'project', label: '项目描述',
      aliases: ['项目描述', '项目内容', '项目职责', '项目介绍'],
      generic: ['projectdescription'],
      negative: [],
      ac: [],
      types: ['textarea'],
    },
    {
      key: 'projects.link', section: 'project', label: '项目链接',
      aliases: ['项目链接', '项目地址'],
      generic: ['projectlink', 'projecturl'],
      negative: [],
      ac: [],
      types: ['text', 'url'],
    },
    {
      key: 'projects.company', section: 'project', label: '所属公司',
      aliases: ['所属公司', '项目所属公司', '所属企业'],
      generic: ['projectcompany'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'projects.tech', section: 'project', label: '使用技术',
      aliases: ['使用技术', '所用技术', '技术栈', '开发环境', '开发工具'],
      generic: ['technology', 'techstack'],
      negative: [],
      ac: [],
      types: ['text', 'textarea'],
    },
    {
      key: 'projects.teamSize', section: 'project', label: '项目团队规模',
      aliases: ['项目团队规模', '团队规模', '团队人数', '项目人数'],
      generic: ['teamsize'],
      negative: [],
      ac: [],
      types: ['text', 'number', 'select'],
    },
    {
      key: 'projects.achievements', section: 'project', label: '项目成果',
      aliases: ['项目成果', '项目业绩', '项目收获'],
      generic: [],
      negative: [],
      ac: [],
      types: ['textarea', 'text'],
    },

    // ───────────────────────────── 实习经历 ─────────────────────────────
    {
      key: 'internships.company', section: 'internship', label: '实习公司',
      aliases: ['实习公司', '实习单位', '实习企业'],
      generic: ['interncompany', 'internemployer'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'internships.position', section: 'internship', label: '实习岗位',
      aliases: ['实习岗位', '实习职位', '实习职务'],
      generic: ['internposition', 'internrole'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'internships.department', section: 'internship', label: '实习部门',
      aliases: ['实习部门'],
      generic: [],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'internships.startDate', section: 'internship', label: '实习开始时间',
      aliases: ['实习开始时间', '实习起始时间'],
      generic: DATE_START_GENERIC,
      negative: ['入学', '毕业', '入职', '离职'],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'internships.endDate', section: 'internship', label: '实习结束时间',
      aliases: ['实习结束时间', '实习截止时间'],
      generic: DATE_END_GENERIC,
      negative: ['入学', '毕业', '入职', '离职'],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'internships.city', section: 'internship', label: '实习地点',
      aliases: ['实习地点', '实习城市'],
      generic: [],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'internships.description', section: 'internship', label: '实习内容',
      aliases: ['实习内容', '实习职责', '实习描述', '实习工作内容'],
      generic: ['interndescription'],
      negative: [],
      ac: [],
      types: ['textarea'],
    },

    // ───────────────────────────── 证书 ─────────────────────────────
    {
      key: 'certificates.name', section: 'certificate', label: '证书名称',
      aliases: ['证书名称', '证书称号', '证书名', '资质证书', '证书全称'],
      generic: ['certificatename', 'certname'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'certificates.issuer', section: 'certificate', label: '颁发机构',
      aliases: ['颁发机构', '发证机构', '发证机关'],
      generic: ['issuer', 'issuedby'],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'certificates.date', section: 'certificate', label: '获得时间',
      // 「获得时间」同时出现在证书、大赛、奖项三个区块里，只能靠区块消歧，
      // 所以放在弱别名里，强别名用不会撞车的「发证时间」
      aliases: ['发证时间', '证书获得时间', '发证日期'],
      generic: ['获得时间', '取得时间', 'issuedate'],
      negative: [],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'certificates.number', section: 'certificate', label: '证书编号',
      aliases: ['证书编号', '证书号码'],
      generic: ['certificatenumber', 'certno'],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'certificates.level', section: 'certificate', label: '证书等级',
      aliases: ['证书等级', '资格等级', '等级'],
      generic: ['certlevel', 'grade'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },

    // ───────────────────────────── 语言能力 ─────────────────────────────
    {
      key: 'languages.name', section: 'language', label: '语种',
      // 「语言」不出现在强别名里：它太短，会把「语言能力」这种区块标题误判成字段标签
      aliases: ['语种', '外语语种', '语言种类', '外语'],
      generic: ['language', 'languagename'],
      negative: [],
      ac: ['language'],
      types: ['text', 'select'],
    },
    {
      key: 'languages.level', section: 'language', label: '掌握程度',
      // 「掌握程度」IT 技能区块也在用，同样交给区块消歧
      aliases: ['语言水平', '外语水平', '语言掌握程度'],
      generic: ['掌握程度', '熟练程度', 'proficiency', 'languagelevel'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'languages.score', section: 'language', label: '考试成绩',
      aliases: ['考试成绩', '外语成绩', '语言成绩'],
      generic: ['score', 'languagescore'],
      negative: [],
      ac: [],
      types: ['text', 'number'],
    },

    // ───────────────────────────── 获奖情况 ─────────────────────────────
    {
      key: 'awards.name', section: 'award', label: '奖项名称',
      aliases: ['奖项名称', '奖项名', '奖励名称'],
      generic: ['awardname', 'prizename'],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'awards.date', section: 'award', label: '获奖时间',
      aliases: ['获奖时间', '获奖日期', '获奖年度'],
      // 「获得时间」证书、大赛、获奖三个区块都在用，只能靠区块消歧
      generic: ['获得时间', '取得时间', 'awarddate'],
      negative: [],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'awards.level', section: 'award', label: '奖项级别',
      aliases: ['奖项级别', '奖励级别', '奖项等级'],
      generic: ['awardlevel'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'awards.issuer', section: 'award', label: '颁奖单位',
      aliases: ['颁奖单位', '颁奖机构', '授予单位'],
      generic: ['awardissuer'],
      negative: [],
      ac: [],
      types: ['text'],
    },

    // ───────────────────────────── 校园经历 ─────────────────────────────
    {
      key: 'campusExperiences.organization', section: 'campus', label: '组织社团',
      aliases: ['社团名称', '组织名称', '社团组织'],
      generic: ['organization', 'club'],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'campusExperiences.role', section: 'campus', label: '担任职务',
      aliases: ['担任职务', '社团职务', '学生职务'],
      generic: ['clublrole', 'campusrole'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'campusExperiences.startDate', section: 'campus', label: '开始时间',
      aliases: ['社团开始时间', '社团起始时间'],
      generic: DATE_START_GENERIC,
      negative: ['入学', '毕业', '入职', '离职'],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'campusExperiences.endDate', section: 'campus', label: '结束时间',
      // 「任职结束时间」留给了 works.endDate——它在工作经历里指离职
      aliases: ['社团结束时间', '学生工作结束时间'],
      generic: DATE_END_GENERIC,
      negative: ['入学', '毕业', '入职', '离职'],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'campusExperiences.description', section: 'campus', label: '经历描述',
      // 「实践内容」让给了 competitions.description——社团这块用「活动描述」更贴切
      aliases: ['活动描述', '社团经历', '组织经历', '社团活动描述'],
      generic: ['campusdescription', '实践内容'],
      negative: [],
      ac: [],
      types: ['textarea'],
    },

    // ───────────────────────────── 培训经历 ─────────────────────────────
    {
      key: 'trainings.name', section: 'training', label: '培训名称',
      aliases: ['培训名称', '课程名称', '培训课程'],
      generic: ['trainingname', 'coursename'],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'trainings.issuer', section: 'training', label: '培训机构',
      aliases: ['培训机构', '培训单位', '主办单位'],
      generic: ['trainingprovider'],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'trainings.startDate', section: 'training', label: '培训开始时间',
      aliases: ['培训开始时间'],
      generic: DATE_START_GENERIC,
      negative: ['入学', '毕业', '入职', '离职'],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'trainings.endDate', section: 'training', label: '培训结束时间',
      aliases: ['培训结束时间'],
      generic: DATE_END_GENERIC,
      negative: ['入学', '毕业', '入职', '离职'],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'trainings.description', section: 'training', label: '培训内容',
      aliases: ['培训内容', '课程内容', '培训描述'],
      generic: ['trainingdescription'],
      negative: [],
      ac: [],
      types: ['textarea'],
    },

    // ───────────────────────────── 实践 / 竞赛 ─────────────────────────────
    {
      key: 'competitions.name', section: 'competition', label: '大赛名称',
      aliases: ['大赛名称', '竞赛名称', '比赛名称', '大赛项目名称'],
      generic: ['competitionname', 'contestname'],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'competitions.result', section: 'competition', label: '大赛成绩',
      aliases: ['大赛成绩', '竞赛成绩', '比赛成绩', '获奖等级', '竞赛奖项'],
      generic: ['competitionresult', 'awardlevel'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'competitions.date', section: 'competition', label: '参赛时间',
      // 「获得时间」在 §实践经历 和 §其他证书 里都出现，只在弱别名里声明
      aliases: ['参赛时间', '大赛时间', '竞赛时间'],
      generic: ['获得时间', '获奖时间', '获奖日期', 'date'],
      negative: [],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'competitions.description', section: 'competition', label: '实践内容',
      aliases: ['实践内容', '实践经历描述', '竞赛描述', '大赛描述'],
      // 「实践经历」在这个区块里既是标题也是那个文本域的标签，
      // 所以只放弱别名——当标题用时靠区块识别，当标签用时靠区块归属
      generic: ['实践经历', 'practicedescription'],
      negative: [],
      ac: [],
      types: ['textarea', 'text'],
    },

    // ───────────────────────────── 学生干部经历 ─────────────────────────────
    {
      key: 'studentCadreExperiences.organization', section: 'studentCadre', label: '任职组织',
      aliases: ['任职组织', '任职单位', '学生组织', '任职机构'],
      generic: ['cadreorganization'],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'studentCadreExperiences.role', section: 'studentCadre', label: '担任职务',
      aliases: ['任职职务', '干部职务', '学生干部职务'],
      generic: ['cadrerole'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'studentCadreExperiences.startDate', section: 'studentCadre', label: '任职开始时间',
      // 表单上这里通常只写「开始时间」，靠 DATE_START_GENERIC + 区块归属定位。
      // 「任职起始时间」留给了 works.startDate，不重复声明。
      // 「任职时间」是表单上的组标签（里面才分「开始时间 / 结束时间」），
      // 单独出现时按起始时间处理，因为通常挂在左边那个控件上
      aliases: ['任职时间', '任职开始时间', '干部任职开始时间'],
      generic: DATE_START_GENERIC,
      negative: ['入学', '毕业', '入职', '离职'],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'studentCadreExperiences.endDate', section: 'studentCadre', label: '任职结束时间',
      // 「任职结束时间」留给了 works.endDate（那里指离职）
      aliases: ['任职截止时间', '干部任职结束时间'],
      generic: DATE_END_GENERIC,
      negative: ['入职', '离职'],
      ac: [],
      types: ['text', 'date', 'select'],
    },
    {
      key: 'studentCadreExperiences.description', section: 'studentCadre', label: '工作描述',
      // 「工作描述」也是 works.description 的强别名，这里只在弱别名里声明，
      // 靠区块把「学生干部的工作描述」和「上班的工作内容」分开
      aliases: ['学生工作描述', '干部工作描述', '任职描述'],
      generic: ['工作描述', '工作内容'],
      negative: [],
      ac: [],
      types: ['textarea', 'text'],
    },

    // ───────────────────────────── IT 技能 ─────────────────────────────
    {
      key: 'itSkills.name', section: 'itSkill', label: '技能名称',
      aliases: ['技能名称', 'IT技能', '计算机技能', '技术技能'],
      generic: ['skillname', 'itskill'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'itSkills.level', section: 'itSkill', label: '技能掌握程度',
      aliases: ['技能掌握程度', '技术掌握程度', '技能水平'],
      generic: ['掌握程度', '熟练程度', 'skilllevel'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },

    // ───────────────────────────── 紧急联系人 ─────────────────────────────
    {
      key: 'emergency.name', section: 'emergency', label: '紧急联系人',
      aliases: ['紧急联系人姓名', '紧急联络人姓名', '联系人姓名'],
      generic: ['emergencycontactname'],
      negative: [],
      ac: [],
      types: ['text'],
    },
    {
      key: 'emergency.relation', section: 'emergency', label: '与本人关系',
      aliases: ['与本人关系', '关系', '亲属关系'],
      generic: ['relationship', 'relation'],
      negative: [],
      ac: [],
      types: ['text', 'select'],
    },
    {
      key: 'emergency.phone', section: 'emergency', label: '紧急联系人电话',
      aliases: ['紧急联系人电话', '紧急联系人手机', '紧急联系人手机号',
        '紧急联络电话', '紧急联络人手机', '联系人电话'],
      generic: ['emergencycontactphone'],
      negative: [],
      ac: [],
      types: ['tel', 'text'],
      maxLength: [11, 13],
    },
  ];

  /** key → def 的索引 */
  const BY_KEY = Object.create(null);
  for (const d of DEFS) BY_KEY[d.key] = d;

  /** 区块别名：用于把页面上的标题文字归类到区块 */
  const SECTION_ALIASES = {
    basic: ['基本信息', '个人信息', '基本资料', '个人资料', '联系方式', '基本信息填写'],
    jobIntention: ['求职意向', '职位意向', '应聘意向', '工作意向', '求职期望'],
    education: ['教育经历', '教育背景', '学习经历', '学历信息', '教育信息', '教育与培训'],
    work: ['工作经历', '工作经验', '职业经历', '工作履历', '就职经历', '职业发展'],
    internship: ['实习经历', '实习经验', '实习信息', '实习情况'],
    project: ['项目经历', '项目经验', '项目信息', '主要项目'],
    certificate: ['证书信息', '资格证书', '专业证书', '证书情况', '资质证书'],
    language: ['语言能力', '语言水平', '外语水平', '语言情况', '语言技能'],
    award: ['获奖情况', '获奖经历', '荣誉奖项', '奖励情况', '所获奖励', '获奖信息'],
    // 「社会实践」是志愿服务一类，归校园经历，不要和竞赛的「实践经历」混为一谈
    campus: ['校园经历', '社团经历', '校园活动', '社团活动', '社会实践'],
    training: ['培训经历', '培训信息', '进修经历', '培训情况'],
    competition: ['实践经历', '竞赛经历', '大赛经历', '比赛经历', '竞赛获奖', '实践活动'],
    studentCadre: ['学生干部经历', '学生干部', '干部经历', '学生工作经历'],
    // 这里不能放「技能特长」——它是 basic.skills 的强别名，
    // 放进来会让基本信息里的「技能特长」小标题被误判成 IT 技能区块
    itSkill: ['IT技能', '计算机技能', '技术技能'],
    emergency: ['紧急联系人', '紧急联络人', '家庭联系方式', '紧急情况联系人'],
  };

  /** 各区块的英文别名（有些站点用英文标题） */
  const SECTION_ALIASES_EN = {
    basic: ['basic', 'personal', 'personalinfo', 'contact', 'contactinfo'],
    jobIntention: ['jobintention', 'careerobjective', 'preference'],
    education: ['education', 'educational', 'academic'],
    work: ['work', 'workexperience', 'employment', 'experience', 'career'],
    internship: ['internship', 'internexperience'],
    project: ['project', 'projects', 'projectexperience'],
    certificate: ['certificate', 'certificates', 'certification'],
    language: ['language', 'languages', 'languageskill'],
    award: ['award', 'awards', 'honor', 'honors'],
    campus: ['campus', 'club', 'activities'],
    training: ['training', 'trainings', 'course'],
    competition: ['competition', 'contest', 'practice'],
    studentCadre: ['studentcadre', 'studentleadership'],
    itSkill: ['itskill', 'itskills', 'techskill'],
    emergency: ['emergency', 'emergencycontact'],
  };

  /** 属于某个区块的所有 key */
  const KEYS_BY_SECTION = Object.create(null);
  for (const d of DEFS) {
    (KEYS_BY_SECTION[d.section] || (KEYS_BY_SECTION[d.section] = [])).push(d.key);
  }

  /** 经历类区块（可以有多个重复条目，需要按 DOM 顺序对应数组下标） */
  const REPEATING_SECTIONS = [
    'education', 'work', 'internship', 'project',
    'certificate', 'language', 'award', 'campus', 'training',
    'competition', 'studentCadre', 'itSkill',
  ];

  /** 简历数据里对应的数组字段名 */
  const ARRAY_NAME_BY_SECTION = {
    education: 'educations',
    work: 'works',
    internship: 'internships',
    project: 'projects',
    certificate: 'certificates',
    language: 'languages',
    award: 'awards',
    campus: 'campusExperiences',
    training: 'trainings',
    competition: 'competitions',
    studentCadre: 'studentCadreExperiences',
    itSkill: 'itSkills',
  };

  /**
   * 取值固定的字段 → 可选值。
   * 表单编辑器里这些渲染成下拉框，避免手打错别字；
   * 填充时仍然按「选项文字」模糊匹配，用户选了自定义值也能工作。
   */
  const ENUM_OPTIONS = {
    'basic.gender': ['男', '女'],
    'basic.idType': ['身份证', '护照', '港澳居民来往内地通行证', '台湾居民来往大陆通行证'],
    'basic.maritalStatus': ['未婚', '已婚', '离异', '丧偶'],
    'basic.politicalStatus': ['中共党员', '中共预备党员', '共青团员', '群众', '民主党派'],
    'basic.isFreshGraduate': ['是', '否'],
    'basic.healthStatus': ['良好', '一般'],
    'educations.degree': ['高中', '中专', '大专', '本科', '硕士', '博士'],
    'educations.isFullTime': ['全日制', '非全日制'],
    'works.employmentType': ['全职', '实习', '兼职', '劳务派遣'],
    'works.stillEmployed': ['是', '否'],
    'jobIntention.jobType': ['全职', '实习', '兼职'],
  };

  /** 区块中文显示名，用于 UI */
  const SECTION_LABEL = {
    basic: '基本信息',
    jobIntention: '求职意向',
    education: '教育经历',
    work: '工作经历',
    internship: '实习经历',
    project: '项目经历',
    certificate: '证书',
    language: '语言能力',
    award: '获奖情况',
    campus: '校园经历',
    training: '培训经历',
    competition: '实践经历',
    studentCadre: '学生干部经历',
    itSkill: 'IT技能',
    emergency: '紧急联系人',
  };

  return (RA.fields = {
    DEFS,
    BY_KEY,
    SECTION_ALIASES,
    SECTION_ALIASES_EN,
    KEYS_BY_SECTION,
    REPEATING_SECTIONS,
    ARRAY_NAME_BY_SECTION,
    SECTION_LABEL,
    ENUM_OPTIONS,
    DATE_START_GENERIC,
    DATE_END_GENERIC,

    /** 表单编辑器的区块展示顺序 */
    SECTION_ORDER: [
      'basic', 'jobIntention', 'education', 'work', 'internship', 'project',
      'campus', 'training', 'certificate', 'language', 'award',
      'competition', 'studentCadre', 'itSkill', 'emergency',
    ],

    /**
     * 字段的显示名。
     *
     * 内置字段永远用定义里的名字——不允许用户在模板里改，
     * 否则「手机号码」被改成「联系方式」之后，用户自己都分不清它对应哪一项。
     * 自定义字段（key 以 custom. 开头）才用用户自己起的名字。
     */
    labelOf(field) {
      if (!field) return '';
      const key = field.key || '';
      if (key.indexOf('custom.') === 0) return field.label || '（未命名字段）';
      const def = BY_KEY[key];
      return def ? def.label : (field.label || key);
    },

    /** 是不是自定义字段 */
    isCustom(field) {
      return !!(field && typeof field.key === 'string' && field.key.indexOf('custom.') === 0);
    },

    /** 某个 key 是否属于可以重复的区块 */
    isRepeating(key) {
      const d = BY_KEY[key];
      return !!d && REPEATING_SECTIONS.includes(d.section);
    },

    /** 取某个 key 的区块 */
    sectionOf(key) {
      const d = BY_KEY[key];
      return d ? d.section : null;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
